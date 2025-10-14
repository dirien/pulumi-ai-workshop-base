import * as pulumi from "@pulumi/pulumi";
import * as digitalocean from "@pulumi/digitalocean";
import * as pulumiservice from "@pulumi/pulumiservice";
import * as k8s from "@pulumi/kubernetes";


const clusterRegion = "fra1";
const nodePoolName = "default";
const nodeCount = 1;
const version = "1.33.1-do.4";
const doCluster = new digitalocean.KubernetesCluster("do-cluster", {
    name: "gitops-promotion-tools-do-cluster",
    region: clusterRegion,
    version: version,
    destroyAllAssociatedResources: true,
    nodePool: {
        name: nodePoolName,
        size: "s-4vcpu-8gb",
        nodeCount: nodeCount,
    },
});

const environmentResource = new pulumiservice.Environment("environmentResource", {
    name: doCluster.name,
    project: "gitops-promotion-tools",
    organization: pulumi.getOrganization(),
    yaml: new pulumi.asset.StringAsset(`
imports:
- pulumi-idp/auth
values:
  stackRefs:
    fn::open::pulumi-stacks:
      stacks:
        do:
          stack: ${pulumi.getProject()}/${pulumi.getStack()}
  pulumiConfig:
    kubernetes:kubeconfig: \${stackRefs.do.kubeconfig}
  files:
    KUBECONFIG: \${stackRefs.do.kubeconfig}    
`),
}, {
    dependsOn: [doCluster],
});

export const usage = pulumi.interpolate`To connect to your cluster, run: 'pulumi env run ${environmentResource.project}/${environmentResource.name} -i -- kubectl | k9s'
To deploy the base tools, change to the base-tools directory and run: 'pulumi up' (you may need to run 'pulumi stack init dev' first)
`;

export const name = doCluster.name;
export const kubeconfig = doCluster.kubeConfigs.apply(kubeConfigs => kubeConfigs[0].rawConfig);
export const envrionmentResourceName = environmentResource.name;

const k8sProvider = new k8s.Provider("k8s-provider", {
    kubeconfig: doCluster.kubeConfigs[0].rawConfig,
});

const metricsServer = new k8s.helm.v3.Release("metrics-server", {
    name: "metrics-server",
    chart: "metrics-server",
    repositoryOpts: {
        repo: "https://kubernetes-sigs.github.io/metrics-server/",
    },
    namespace: "kube-system",
}, {
    ignoreChanges: ["checksum", "version"],
    provider: k8sProvider,
});

const prometheus = new k8s.helm.v3.Release("prometheus", {
    name: "kube-prometheus-stack",
    chart: "oci://ghcr.io/prometheus-community/charts/kube-prometheus-stack",
    namespace: "monitoring",
    createNamespace: true,
    values: {
        prometheus: {
            prometheusSpec: {
                serviceMonitorSelectorNilUsesHelmValues: false,
            }
        }
    }
}, {
    ignoreChanges: ["checksum", "version", "values"],
    provider: k8sProvider,
    dependsOn: [metricsServer],
});

const podinfo = new k8s.helm.v3.Release("podinfo", {
    name: "podinfo",
    chart: "oci://ghcr.io/stefanprodan/charts/podinfo",
    values: {
        resources: {
            requests: {
                cpu: "1m",
                memory: "8Gi",
            }
        },
        serviceMonitor: {
            enabled: true,
        }
    }
}, {
    ignoreChanges: ["checksum", "version"],
    provider: k8sProvider,
    dependsOn: [prometheus],
});

// Install KEDA v2.18.0 for autoscaling
const keda = new k8s.helm.v3.Release("keda", {
    name: "keda",
    chart: "keda",
    version: "2.18.0",
    repositoryOpts: {
        repo: "https://kedacore.github.io/charts",
    },
    namespace: "keda",
    createNamespace: true,
}, {
    ignoreChanges: ["checksum"],
    provider: k8sProvider,
    dependsOn: [metricsServer],
});

// Create ScaledObject to autoscale podinfo based on HTTP request metrics from Prometheus
const podinfoScaledObject = new k8s.apiextensions.CustomResource("podinfo-scaledobject", {
    apiVersion: "keda.sh/v1alpha1",
    kind: "ScaledObject",
    metadata: {
        name: "podinfo-scaledobject",
        namespace: "default",
    },
    spec: {
        scaleTargetRef: {
            name: "podinfo",
        },
        minReplicaCount: 1,
        maxReplicaCount: 10,
        triggers: [
            {
                type: "prometheus",
                metadata: {
                    serverAddress: "http://kube-prometheus-stack-prometheus.monitoring.svc.cluster.local:9090",
                    metricName: "http_requests_total",
                    query: "sum(rate(http_requests_total{app=\"podinfo\"}[2m]))",
                    threshold: "100",
                },
            },
        ],
    },
}, {
    provider: k8sProvider,
    dependsOn: [keda, podinfo, prometheus],
});
