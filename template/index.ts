import * as pulumi from "@pulumi/pulumi";
import * as digitalocean from "@pulumi/digitalocean";
import * as pulumiservice from "@pulumi/pulumiservice";
import * as k8s from "@pulumi/kubernetes";

// Load configuration values
const config = new pulumi.Config();
const clusterRegion = config.get("clusterRegion") || "fra1";
const nodeCount = config.getNumber("nodeCount") || 1;
const version = config.get("kubernetesVersion") || "1.33.1-do.5";
const nodeSize = config.get("nodeSize") || "s-4vcpu-8gb";
const escProject = config.get("escProject") || "gitops-promotion-tools";
const escAuthEnvironment = config.get("escAuthEnvironment") || "pulumi-idp/auth";

const nodePoolName = "default";

const doCluster = new digitalocean.KubernetesCluster("do-cluster", {
    name: `${pulumi.getProject()}-do-cluster`,
    region: clusterRegion,
    version: version,
    destroyAllAssociatedResources: true,
    nodePool: {
        name: nodePoolName,
        size: nodeSize,
        nodeCount: nodeCount,
    },
});

const environmentResource = new pulumiservice.Environment("environmentResource", {
    name: doCluster.name,
    project: escProject,
    organization: pulumi.getOrganization(),
    yaml: new pulumi.asset.StringAsset(`
imports:
- ${escAuthEnvironment}
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
