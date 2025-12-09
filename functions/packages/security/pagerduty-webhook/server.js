const http = require('http');

const PULUMI_ACCESS_TOKEN = process.env.PULUMI_ACCESS_TOKEN;
const PULUMI_ORG = process.env.PULUMI_ORG;
const PAGERDUTY_API_TOKEN = process.env.PAGERDUTY_API_TOKEN;
const PORT = process.env.PORT || 8080;

// Default infrastructure context (used when alerts don't have custom fields)
const DEFAULT_GIT_REPO = process.env.GIT_REPO || "https://github.com/dirien/pulumi-ai-workshop-base";
const DEFAULT_PULUMI_PROJECT = process.env.PULUMI_PROJECT || "pulumi-ai-workshop-base";
const DEFAULT_PULUMI_STACK = process.env.PULUMI_STACK || "dev";
const DEFAULT_ESC_ENVIRONMENT = process.env.ESC_ENVIRONMENT || "gitops-promotion-tools/gitops-promotion-tools-do-cluster";
const DEFAULT_CLUSTER_NAME = process.env.CLUSTER_NAME || "gitops-promotion-tools-do-cluster";
const DEFAULT_CLUSTER_PROVIDER = process.env.CLUSTER_PROVIDER || "digitalocean";

// Fetch alerts for an incident to get custom_details from Falco
async function fetchIncidentAlerts(incidentId) {
    if (!PAGERDUTY_API_TOKEN || !incidentId || incidentId === "unknown") {
        return null;
    }

    try {
        const response = await fetch(
            `https://api.pagerduty.com/incidents/${incidentId}/alerts`,
            {
                method: "GET",
                headers: {
                    "Accept": "application/json",
                    "Content-Type": "application/json",
                    "Authorization": `Token token=${PAGERDUTY_API_TOKEN}`,
                },
            }
        );

        if (!response.ok) {
            console.error(`Failed to fetch alerts: ${response.status}`);
            return null;
        }

        const data = await response.json();
        return data.alerts || [];
    } catch (err) {
        console.error("Error fetching alerts:", err);
        return null;
    }
}

// Extract custom fields from alert body (Falco Sidekick custom_details)
function extractCustomFields(alerts) {
    if (!alerts || alerts.length === 0) return {};

    // Get custom_details from the first alert's body
    const firstAlert = alerts[0];
    const customDetails = firstAlert?.body?.details?.custom_details ||
                          firstAlert?.body?.cef_details?.details ||
                          {};

    // Look for our Falco Sidekick custom fields, fall back to defaults
    return {
        git_repo: customDetails.git_repo || DEFAULT_GIT_REPO,
        pulumi_org: customDetails.pulumi_org || PULUMI_ORG,
        pulumi_project: customDetails.pulumi_project || DEFAULT_PULUMI_PROJECT,
        pulumi_stack: customDetails.pulumi_stack || DEFAULT_PULUMI_STACK,
        esc_environment: customDetails.esc_environment || DEFAULT_ESC_ENVIRONMENT,
        cluster_name: customDetails.cluster_name || DEFAULT_CLUSTER_NAME,
        cluster_provider: customDetails.cluster_provider || DEFAULT_CLUSTER_PROVIDER,
        // Also extract Falco-specific fields
        rule: customDetails.rule || firstAlert?.body?.details?.rule || "",
        priority: customDetails.priority || firstAlert?.body?.details?.priority || "",
        source: customDetails.source || firstAlert?.body?.details?.source || "",
        output: customDetails.output || "",
        output_fields: customDetails.output_fields || {},
    };
}

async function handleWebhook(body) {
    console.log("Received webhook payload:", JSON.stringify(body, null, 2));

    // Parse PagerDuty webhook payload (V3 webhook format)
    const event = body.event?.event_type || body.messages?.[0]?.event;
    console.log("Parsed event type:", event);

    // PagerDuty Generic V2 Webhook uses "incident.trigger" (without 'd')
    if (event !== "incident.trigger" && event !== "incident.triggered") {
        console.log("Ignoring event:", event);
        return {
            statusCode: 200,
            body: JSON.stringify({ status: "ignored", reason: "not a trigger event" })
        };
    }

    console.log("Processing trigger event:", event);

    const incident = body.event?.data || body.messages?.[0]?.incident;

    // Build incident details for Neo prompt
    const incidentDetails = {
        id: incident?.id || "unknown",
        title: incident?.title || "unknown",
        urgency: incident?.urgency || "unknown",
        service: incident?.service?.summary || "unknown",
        description: incident?.description || "",
        html_url: incident?.html_url || "",
    };

    // Fetch alerts to get custom_details from Falco Sidekick
    const alerts = await fetchIncidentAlerts(incidentDetails.id);
    const customFields = extractCustomFields(alerts);

    // Build context section (always include since we have defaults)
    const contextSection = `
## Infrastructure Context
- Git Repository: ${customFields.git_repo}
- Pulumi Org: ${customFields.pulumi_org}
- Pulumi Project: ${customFields.pulumi_project}
- Pulumi Stack: ${customFields.pulumi_stack}
- ESC Environment: ${customFields.esc_environment}
- Cluster Name: ${customFields.cluster_name}
- Cluster Provider: ${customFields.cluster_provider}
`;

    // Build Falco section if we have Falco-specific fields
    let falcoSection = "";
    if (customFields.rule || customFields.output) {
        falcoSection = `
## Falco Alert Details
- Rule: ${customFields.rule || "N/A"}
- Priority: ${customFields.priority || "N/A"}
- Source: ${customFields.source || "N/A"}
- Output: ${customFields.output || "N/A"}
`;
        if (Object.keys(customFields.output_fields).length > 0) {
            falcoSection += `- Output Fields: ${JSON.stringify(customFields.output_fields, null, 2)}\n`;
        }
    }

    const neoPrompt = `Hey Neo, you got work from a PagerDuty incident. Here are the incident details:

## Incident Information
- ID: ${incidentDetails.id}
- Title: ${incidentDetails.title}
- Urgency: ${incidentDetails.urgency}
- Service: ${incidentDetails.service}
- Description: ${incidentDetails.description}
- URL: ${incidentDetails.html_url}
${contextSection}${falcoSection}

## Instructions

1. **Investigate**: Analyze the incident details and determine the root cause.

2. **Check for fixable issues**: If this is a CVE/vulnerability alert (like "Critical CVE detected"), check the Git repository (${customFields.git_repo}) in the \`beijing/\` directory for a Pulumi deployment that uses the vulnerable image. The file to check is \`index.ts\`. Look for Kubernetes deployments with vulnerable images that can be updated to a patched version.

3. **Fix if possible**: If you find vulnerable code that can be fixed:
   - Clone the repo and create a fix branch
   - Update the image tag to a patched version (e.g., nginx:1.14.0 -> nginx:stable or nginx:1.27)
   - Create a PR with the fix
   - Post the PR link in the incident notes

4. **Update PagerDuty**:
   - Use the ${customFields.esc_environment} ESC environment to get the pagerduty-token
   - Reassign the incident to User "Neo" before starting
   - Post your investigation findings and any fix PRs to the incident notes
   - If fully resolved, resolve the incident. Otherwise reassign back to the original assignee.

5. **Kubernetes access**: Use \`pulumi env run ${customFields.esc_environment} -i -- kubectl ...\` to inspect the cluster if needed.
`;

    console.log("Creating Neo task with prompt:", neoPrompt.substring(0, 200) + "...");
    console.log("Pulumi org:", PULUMI_ORG);
    console.log("Has access token:", !!PULUMI_ACCESS_TOKEN);

    // Call Pulumi Neo REST API to create a new task
    const response = await fetch(
        `https://api.pulumi.com/api/preview/agents/${PULUMI_ORG}/tasks`,
        {
            method: "POST",
            headers: {
                "Accept": "application/vnd.pulumi+8",
                "Content-Type": "application/json",
                "Authorization": `token ${PULUMI_ACCESS_TOKEN}`,
            },
            body: JSON.stringify({
                message: {
                    type: "user_message",
                    content: neoPrompt,
                    timestamp: new Date().toISOString(),
                },
            }),
        }
    );

    const result = await response.json();
    console.log("Neo API response:", response.status, JSON.stringify(result));

    return {
        statusCode: response.ok ? 201 : 500,
        body: JSON.stringify({ status: response.ok ? "ok" : "error", taskId: result.taskId, response: result })
    };
}

const server = http.createServer(async (req, res) => {
    // Health check endpoint
    if (req.method === 'GET' && req.url === '/health') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'healthy' }));
        return;
    }

    // Webhook endpoint
    if (req.method === 'POST') {
        let body = '';
        req.on('data', chunk => { body += chunk; });
        req.on('end', async () => {
            try {
                const parsed = JSON.parse(body);
                const result = await handleWebhook(parsed);
                res.writeHead(result.statusCode, { 'Content-Type': 'application/json' });
                res.end(result.body);
            } catch (err) {
                console.error('Error processing webhook:', err);
                res.writeHead(500, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: err.message }));
            }
        });
        return;
    }

    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Not found' }));
});

server.listen(PORT, () => {
    console.log(`Webhook server listening on port ${PORT}`);
});
