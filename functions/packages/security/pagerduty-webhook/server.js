const http = require('http');

const PULUMI_ACCESS_TOKEN = process.env.PULUMI_ACCESS_TOKEN;
const PULUMI_ORG = process.env.PULUMI_ORG;
const PAGERDUTY_API_TOKEN = process.env.PAGERDUTY_API_TOKEN;
const PORT = process.env.PORT || 8080;

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

    // Look for our Falco Sidekick custom fields
    return {
        git_repo: customDetails.git_repo || "",
        pulumi_org: customDetails.pulumi_org || "",
        pulumi_project: customDetails.pulumi_project || "",
        pulumi_stack: customDetails.pulumi_stack || "",
        esc_environment: customDetails.esc_environment || "",
        cluster_name: customDetails.cluster_name || "",
        cluster_provider: customDetails.cluster_provider || "",
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

    // Build context section if we have custom fields
    let contextSection = "";
    if (customFields.git_repo || customFields.cluster_name) {
        contextSection = `
## Infrastructure Context
- Git Repository: ${customFields.git_repo || "N/A"}
- Pulumi Org: ${customFields.pulumi_org || "N/A"}
- Pulumi Project: ${customFields.pulumi_project || "N/A"}
- Pulumi Stack: ${customFields.pulumi_stack || "N/A"}
- ESC Environment: ${customFields.esc_environment || "N/A"}
- Cluster Name: ${customFields.cluster_name || "N/A"}
- Cluster Provider: ${customFields.cluster_provider || "N/A"}
`;
    }

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

Have a look and let me know. Use the ${customFields.esc_environment || "gitops-promotion-tools/gitops-promotion-tools-do-cluster"} ESC environment to make calls with the pagerduty-token against the PagerDuty API if needed.

Before you start, reassign the incident to the User Neo and post the result of your investigation to the incident notes. Use the API for that.

If you think that you solved the issue completely, resolve the incident using the API as well. Otherwise reassign it back to the previous assignee.
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
