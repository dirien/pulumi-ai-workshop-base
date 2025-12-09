import * as pulumi from "@pulumi/pulumi";
import * as digitalocean from "@pulumi/digitalocean";
import * as pulumiservice from "@pulumi/pulumiservice";
import * as k8s from "@pulumi/kubernetes";
import * as pagerduty from "@pulumi/pagerduty";
import * as dockerBuild from "@pulumi/docker-build";

const config = new pulumi.Config();
const pagerdutyConfig = new pulumi.Config("pagerduty");


const clusterRegion = "fra1";
const nodePoolName = "default";
const nodeCount = 3;
const version = "1.34.1-do.1";
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

// =============================================================================
// PagerDuty Resources
// =============================================================================

// Get existing user for escalation
const pagerdutyUser = pagerduty.getUser({ email: config.require("pagerduty-email") });

// Escalation policy for security incidents
const securityEscalation = new pagerduty.EscalationPolicy("security-escalation", {
    name: "K8s Security Escalation",
    numLoops: 2,
    rules: [{
        escalationDelayInMinutes: 10,
        targets: [{
            type: "user_reference",
            id: pagerdutyUser.then(u => u.id),
        }],
    }],
});

// PagerDuty Service for K8s security incidents
const securityService = new pagerduty.Service("k8s-security-service", {
    name: "Kubernetes Security Incidents",
    escalationPolicy: securityEscalation.id,
    alertCreation: "create_alerts_and_incidents",
});

// Events API v2 Integration for Falcosidekick
const falcoIntegration = new pagerduty.ServiceIntegration("falco-integration", {
    name: "Falco Security Events",
    service: securityService.id,
    type: "events_api_v2_inbound_integration",
});

// Events API v2 Integration for Alertmanager
const alertmanagerIntegration = new pagerduty.ServiceIntegration("alertmanager-integration", {
    name: "Alertmanager Events",
    service: securityService.id,
    type: "events_api_v2_inbound_integration",
});

// =============================================================================
// Kubernetes Provider
// =============================================================================

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
            },
        },
        alertmanager: {
            config: {
                global: {
                    resolve_timeout: "5m",
                },
                route: {
                    group_by: ["alertname", "severity"],
                    group_wait: "30s",
                    group_interval: "5m",
                    repeat_interval: "4h",
                    receiver: "pagerduty-security",
                    routes: [
                        // Route Kyverno PolicyViolation alerts for default namespace to PagerDuty
                        // (before namespace silencing, since Kyverno controller runs in kyverno namespace)
                        {
                            matchers: ["alertname = PolicyViolationDetected", "resource_namespace = default"],
                            receiver: "pagerduty-security",
                        },
                        // Silence alerts from infrastructure namespaces
                        {
                            matchers: ["namespace = kube-system"],
                            receiver: "null",
                        },
                        {
                            matchers: ["namespace = monitoring"],
                            receiver: "null",
                        },
                        {
                            matchers: ["namespace = kyverno"],
                            receiver: "null",
                        },
                        {
                            matchers: ["namespace = security"],
                            receiver: "null",
                        },
                        {
                            matchers: ["namespace = trivy-system"],
                            receiver: "null",
                        },
                        // Route security alerts to PagerDuty
                        {
                            matchers: ["severity = critical"],
                            receiver: "pagerduty-security",
                        },
                        {
                            matchers: ["severity = warning"],
                            receiver: "pagerduty-security",
                        },
                    ],
                },
                receivers: [
                    {
                        name: "null",
                    },
                    {
                        name: "pagerduty-security",
                        pagerduty_configs: [{
                            routing_key: alertmanagerIntegration.integrationKey,
                            // Severity must be exactly: critical, warning, error, or info
                            // Default to 'warning' if severity label is missing or invalid
                            severity: '{{ if eq .Status "firing" }}{{ if or (eq .CommonLabels.severity "critical") (eq .CommonLabels.severity "warning") (eq .CommonLabels.severity "error") (eq .CommonLabels.severity "info") }}{{ .CommonLabels.severity }}{{ else }}warning{{ end }}{{ else }}info{{ end }}',
                            // Description with fallback to alertname if summary is empty
                            description: '{{ if .CommonAnnotations.summary }}{{ .CommonAnnotations.summary }}{{ else }}{{ .CommonLabels.alertname }}: {{ .CommonAnnotations.description }}{{ end }}',
                            details: {
                                alertname: '{{ .CommonLabels.alertname }}',
                                namespace: '{{ .CommonLabels.namespace }}',
                                pod: '{{ .CommonLabels.pod }}',
                                image: '{{ .CommonLabels.image_repository }}:{{ .CommonLabels.image_tag }}',
                            },
                        }],
                    },
                ],
            },
        },
        // Custom alerting rules for security scenarios
        additionalPrometheusRulesMap: {
            "security-rules": {
                groups: [
                    {
                        name: "trivy-alerts",
                        rules: [
                            {
                                alert: "CriticalVulnerabilityDetected",
                                expr: 'trivy_image_vulnerabilities{severity="Critical"} > 0',
                                "for": "1m",
                                labels: { severity: "critical" },
                                annotations: {
                                    summary: "Critical CVE detected in {{ $labels.image_repository }}",
                                    description: "Image {{ $labels.image_repository }}:{{ $labels.image_tag }} has {{ $value }} critical vulnerabilities",
                                },
                            },
                        ],
                    },
                    {
                        name: "kyverno-alerts",
                        rules: [
                            {
                                alert: "PolicyViolationDetected",
                                expr: "increase(kyverno_policy_results_total{rule_result='fail'}[5m]) > 0",
                                "for": "1m",
                                labels: { severity: "warning" },
                                annotations: {
                                    summary: "Kyverno policy violation: {{ $labels.policy_name }}",
                                    description: "Policy {{ $labels.policy_name }} failed for resource in namespace {{ $labels.resource_namespace }}",
                                },
                            },
                        ],
                    },
                    {
                        name: "resource-alerts",
                        rules: [
                            {
                                alert: "PodMemoryExhaustion",
                                expr: "container_memory_usage_bytes / container_spec_memory_limit_bytes > 0.9",
                                "for": "5m",
                                labels: { severity: "warning" },
                                annotations: {
                                    summary: "Pod {{ $labels.pod }} memory exhaustion",
                                    description: "Pod {{ $labels.pod }} in namespace {{ $labels.namespace }} is using >90% of memory limit",
                                },
                            },
                            {
                                alert: "PodCPUThrottling",
                                expr: "rate(container_cpu_cfs_throttled_seconds_total[5m]) > 0.5",
                                "for": "5m",
                                labels: { severity: "warning" },
                                annotations: {
                                    summary: "Pod {{ $labels.pod }} CPU throttling",
                                    description: "Pod {{ $labels.pod }} in namespace {{ $labels.namespace }} is being CPU throttled",
                                },
                            },
                        ],
                    },
                ],
            },
        },
    },
}, {
    ignoreChanges: ["checksum", "version", "values"],
    provider: k8sProvider,
    dependsOn: [metricsServer],
});

// =============================================================================
// Security Tools - Falco (Scenario 1: Shell in Pod Detection)
// =============================================================================

const falco = new k8s.helm.v3.Release("falco", {
    name: "falco",
    chart: "falco",
    repositoryOpts: { repo: "https://falcosecurity.github.io/charts" },
    namespace: "security",
    createNamespace: true,
    values: {
        driver: {
            kind: "modern_ebpf",  // No kernel module download needed - works on DO
        },
        falcosidekick: {
            enabled: true,
            config: {
                pagerduty: {
                    routingkey: falcoIntegration.integrationKey,
                },
                // Custom fields added to all outputs (including PagerDuty custom_details)
                customfields: {
                    git_repo: "https://github.com/dirien/pulumi-ai-workshop-base",
                    pulumi_org: "gitops-promotion-tools",
                    pulumi_project: "pulumi-ai-workshop-base",
                    pulumi_stack: "dev",
                    esc_environment: "gitops-promotion-tools/gitops-promotion-tools-do-cluster",
                    cluster_name: "gitops-promotion-tools-do-cluster",
                    cluster_provider: "digitalocean",
                },
            },
        },
        collectors: {
            kubernetes: {
                enabled: true,
            },
        },
        // Custom rules to reduce noise from known-safe Kubernetes components
        customRules: {
            "custom-rules.yaml": `
# Exception: Cilium ARP-fix pings (network health checks - safe)
- macro: cilium_arp_fix_ping
  condition: >
    (k8s.ns.name = "kube-system" and
     k8s.pod.name startswith "cilium-" and
     container.name = "arp-fix" and
     proc.name = "ping")

# Exception: Grafana sidecars connecting to K8s API (expected behavior)
- macro: grafana_sidecar_k8s_api
  condition: >
    (k8s.ns.name = "monitoring" and
     k8s.pod.name startswith "kube-prometheus-stack-grafana-" and
     container.name in ("grafana-sc-datasources", "grafana-sc-dashboard") and
     proc.name = "python")

# Override: Redirect STDOUT/STDIN rule with Cilium exception
# NOTE: Rule name must EXACTLY match the default rule name (case-sensitive)
- rule: Redirect STDOUT/STDIN to Network Connection in Container
  desc: Detect redirection of stdout/stdin to a network connection in a container (with exceptions)
  condition: >
    evt.type in (dup, dup2, dup3) and evt.dir=< and
    container and
    fd.num in (0, 1, 2) and
    fd.type in ("ipv4", "ipv6") and
    not cilium_arp_fix_ping
  output: >
    Redirect stdout/stdin to network connection
    (gparent=%proc.aname[2] ggparent=%proc.aname[3] gggparent=%proc.aname[4]
    connection=%fd.name lport=%fd.lport rport=%fd.rport fd_type=%fd.type
    evt_type=%evt.type user=%user.name process=%proc.name command=%proc.cmdline %container.info)
  priority: NOTICE
  tags: [network, process, mitre_execution, T1059]
  enabled: true

# Override: K8s API connection rule with Grafana sidecar exception
# NOTE: Rule name must EXACTLY match the default rule name (case-sensitive) - uses uppercase "K8S"
- rule: Contact K8S API Server From Container
  desc: Detect attempts to contact the K8s API Server from a container (with exceptions)
  condition: >
    evt.type = connect and
    evt.dir = < and
    container and
    fd.rport = 443 and
    fd.sip = "10.115.0.1" and
    not grafana_sidecar_k8s_api
  output: >
    Unexpected connection to K8s API Server from container
    (connection=%fd.name lport=%fd.lport rport=%fd.rport fd_type=%fd.type
    evt_type=%evt.type user=%user.name process=%proc.name command=%proc.cmdline %container.info)
  priority: NOTICE
  tags: [network, k8s, mitre_discovery]
  enabled: true

# Workshop rule: Shell spawned in container (without TTY requirement)
# The default "Terminal shell in container" rule requires proc.tty != 0,
# but when using pulumi env run, TTY is not passed through.
# This custom rule detects shell processes in non-system namespaces.
- rule: Shell Spawned in Container (Workshop)
  desc: >
    Detects when a shell process is spawned in a container. Unlike the default rule,
    this does not require a TTY to be attached, making it work with kubectl exec
    executed through CI/CD pipelines or pulumi env run.
  condition: >
    spawned_process and
    container and
    shell_procs and
    not k8s.ns.name in (kube-system, kube-public, kube-node-lease, security, monitoring, trivy-system, kyverno)
  output: >
    Shell spawned in container (without TTY check) |
    pod=%k8s.pod.name namespace=%k8s.ns.name container=%container.name
    user=%user.name command=%proc.cmdline terminal=%proc.tty
    parent=%proc.pname image=%container.image.repository
  priority: WARNING
  tags: [container, shell, mitre_execution, T1059, workshop]
  enabled: true
`,
        },
    },
}, {
    provider: k8sProvider,
    dependsOn: [prometheus],
    ignoreChanges: ["checksum", "version"],
});

// =============================================================================
// Security Tools - Trivy Operator (Scenario 2: CVE Detection)
// =============================================================================

const trivyOperator = new k8s.helm.v3.Release("trivy-operator", {
    name: "trivy-operator",
    chart: "trivy-operator",
    repositoryOpts: { repo: "https://aquasecurity.github.io/helm-charts/" },
    namespace: "trivy-system",
    createNamespace: true,
    values: {
        trivy: {
            ignoreUnfixed: true,
            // Increase timeout for large image scans
            timeout: "10m0s",
            // Increase resource limits to prevent OOMKilled errors on large images (e.g., Cilium)
            resources: {
                requests: {
                    cpu: "100m",
                    memory: "256M",
                },
                limits: {
                    cpu: "1",
                    memory: "2Gi",  // Increased from 500M to handle large images
                },
            },
        },
        operator: {
            scannerReportTTL: "24h",
            metricsVulnIdEnabled: true,
            // Increase job timeout for large image scans
            scanJobTimeout: "10m",
        },
        // Exclude system and infrastructure namespaces to reduce noise and failed scans
        excludeNamespaces: "kube-system,kube-public,kube-node-lease,monitoring,security,kyverno,trivy-system",
        serviceMonitor: {
            enabled: true,  // Expose metrics to Prometheus
        },
    },
}, {
    provider: k8sProvider,
    dependsOn: [prometheus],
    ignoreChanges: ["checksum", "version"],
});

// =============================================================================
// Security Tools - Kyverno (Scenario 3: Policy Violation)
// =============================================================================

const kyverno = new k8s.helm.v3.Release("kyverno", {
    name: "kyverno",
    chart: "kyverno",
    repositoryOpts: { repo: "https://kyverno.github.io/kyverno/" },
    namespace: "kyverno",
    createNamespace: true,
    values: {
        admissionController: {
            serviceMonitor: {
                enabled: true,  // Expose metrics to Prometheus
            },
        },
        backgroundController: {
            serviceMonitor: {
                enabled: true,
            },
        },
    },
}, {
    provider: k8sProvider,
    dependsOn: [prometheus],
    ignoreChanges: ["checksum", "version"],
});

// Example policy: Disallow privileged containers (Audit mode for workshop)
const disallowPrivileged = new k8s.apiextensions.CustomResource("disallow-privileged", {
    apiVersion: "kyverno.io/v1",
    kind: "ClusterPolicy",
    metadata: {
        name: "disallow-privileged-containers",
    },
    spec: {
        validationFailureAction: "Audit",  // Audit mode for workshop (use "Enforce" in prod)
        background: true,
        rules: [{
            name: "disallow-privileged",
            match: {
                any: [{
                    resources: {
                        kinds: ["Pod"],
                    },
                }],
            },
            validate: {
                message: "Privileged containers are not allowed.",
                pattern: {
                    spec: {
                        containers: [{
                            securityContext: {
                                privileged: "!true",
                            },
                        }],
                    },
                },
            },
        }],
    },
}, { provider: k8sProvider, dependsOn: [kyverno] });

// =============================================================================
// DigitalOcean Container Registry & Webhook Service
// =============================================================================

// Create DO Container Registry
const containerRegistry = new digitalocean.ContainerRegistry("webhook-registry", {
    name: "security-webhook-registry",
    subscriptionTierSlug: "starter",
    region: clusterRegion,
});

// Get registry credentials for Docker push
const registryCredentials = new digitalocean.ContainerRegistryDockerCredentials("registry-creds", {
    registryName: containerRegistry.name,
    write: true,
});

// Build and push webhook Docker image
// DO Container Registry uses API token for authentication
const doConfig = new pulumi.Config("digitalocean");
const doToken = doConfig.requireSecret("token");
const webhookImage = new dockerBuild.Image("webhook-image", {
    tags: [pulumi.interpolate`registry.digitalocean.com/${containerRegistry.name}/pagerduty-webhook:latest`],
    context: {
        location: "./functions/packages/security/pagerduty-webhook",
    },
    platforms: [dockerBuild.Platform.Linux_amd64],
    push: true,
    registries: [{
        address: "registry.digitalocean.com",
        username: doToken,  // DO uses the API token as both username and password
        password: doToken,
    }],
});

// Deploy webhook as DO App Platform service (container-based)
const webhookApp = new digitalocean.App("webhook-app", {
    spec: {
        name: "security-webhook-handler",
        region: clusterRegion,
        services: [{
            name: "pagerduty-webhook",
            instanceCount: 1,
            instanceSizeSlug: "apps-s-1vcpu-0.5gb",
            httpPort: 8080,
            image: {
                registryType: "DOCR",
                registry: containerRegistry.name,
                repository: "pagerduty-webhook",
                tag: "latest",
                deployOnPushes: [{ enabled: true }],  // Auto-deploy when new image is pushed to DOCR
            },
            envs: [
                { key: "PULUMI_ACCESS_TOKEN", value: config.requireSecret("pulumi-pat"), type: "SECRET" },
                { key: "PULUMI_ORG", value: pulumi.getOrganization() },
                { key: "PAGERDUTY_API_TOKEN", value: pagerdutyConfig.requireSecret("token"), type: "SECRET" },
                { key: "PORT", value: "8080" },
            ],
            healthCheck: {
                httpPath: "/health",
            },
        }],
    },
}, { dependsOn: [webhookImage] });

// Export the service URL
export const webhookUrl = webhookApp.defaultIngress;

// =============================================================================
// PagerDuty Webhook Subscription (V3)
// =============================================================================

// V3 Webhook Subscription replaces deprecated V2 Extensions
// See: https://developer.pagerduty.com/docs/webhooks-overview
const webhookSubscription = new pagerduty.WebhookSubscription("pulumi-webhook", {
    description: "Triggers Pulumi Neo for automated incident investigation",
    deliveryMethods: [{
        type: "http_delivery_method",
        url: webhookApp.defaultIngress,
    }],
    events: [
        "incident.triggered",  // Main event we care about - new incidents
    ],
    filters: [{
        type: "service_reference",
        id: securityService.id,
    }],
    type: "webhook_subscription",
}, { dependsOn: [webhookApp] });

// =============================================================================
// Workshop Test Deployments
// =============================================================================

// Vulnerable nginx deployment for CVE detection workshop scenario
// This deployment uses an intentionally vulnerable image (nginx:1.14.0)
// to demonstrate Trivy vulnerability scanning and Neo automated remediation.
// Neo should detect this and create a PR to update to nginx:stable or nginx:1.27
const vulnerableNginxDeployment = new k8s.apps.v1.Deployment("vulnerable-nginx", {
    metadata: {
        name: "vulnerable-nginx",
        namespace: "default",
        labels: {
            app: "vulnerable-nginx",
            "workshop-scenario": "cve-detection",
        },
    },
    spec: {
        replicas: 0,
        selector: {
            matchLabels: {
                app: "vulnerable-nginx",
            },
        },
        template: {
            metadata: {
                labels: {
                    app: "vulnerable-nginx",
                },
            },
            spec: {
                containers: [{
                    name: "nginx",
                    // VULNERABLE: nginx:1.14.0 has 35+ critical CVEs
                    // Neo should fix this by updating to nginx:stable or nginx:1.27
                    image: "nginx:1.14.0",
                    ports: [{
                        containerPort: 80,
                    }],
                    resources: {
                        limits: {
                            cpu: "100m",
                            memory: "128Mi",
                        },
                        requests: {
                            cpu: "50m",
                            memory: "64Mi",
                        },
                    },
                }],
            },
        },
    },
}, { provider: k8sProvider });

// Privileged container deployment for Kyverno policy violation workshop scenario
// This deployment uses an intentionally privileged container
// to demonstrate Kyverno policy enforcement and Neo automated remediation.
// Neo should detect this and create a PR to remove the privileged security context
const privilegedPodDeployment = new k8s.apps.v1.Deployment("privileged-pod", {
    metadata: {
        name: "privileged-pod",
        namespace: "default",
        labels: {
            app: "privileged-pod",
            "workshop-scenario": "policy-violation",
        },
    },
    spec: {
        replicas: 0,
        selector: {
            matchLabels: {
                app: "privileged-pod",
            },
        },
        template: {
            metadata: {
                labels: {
                    app: "privileged-pod",
                },
            },
            spec: {
                containers: [{
                    name: "nginx",
                    image: "nginx:stable",
                    ports: [{
                        containerPort: 80,
                    }],
                    // FIXED: Removed privileged security context to comply with Kyverno policy
                    securityContext: {
                        privileged: false,
                    },
                    resources: {
                        limits: {
                            cpu: "100m",
                            memory: "128Mi",
                        },
                        requests: {
                            cpu: "50m",
                            memory: "64Mi",
                        },
                    },
                }],
            },
        },
    },
}, { provider: k8sProvider });

// =============================================================================
// Exports
// =============================================================================

export const pagerdutyServiceId = securityService.id;
export const falcoIntegrationKey = falcoIntegration.integrationKey;
export const alertmanagerIntegrationKey = alertmanagerIntegration.integrationKey;
