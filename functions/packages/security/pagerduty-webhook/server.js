const http = require('http');

const PULUMI_ACCESS_TOKEN = process.env.PULUMI_ACCESS_TOKEN;
const PULUMI_ORG = process.env.PULUMI_ORG;
const PULUMI_PROJECT = process.env.PULUMI_PROJECT;
const PULUMI_STACK = process.env.PULUMI_STACK;
const PORT = process.env.PORT || 8080;

async function handleWebhook(body) {
    // Parse PagerDuty webhook payload (V3 webhook format)
    const event = body.event?.event_type || body.messages?.[0]?.event;

    if (event !== "incident.triggered") {
        return {
            statusCode: 200,
            body: JSON.stringify({ status: "ignored", reason: "not a trigger event" })
        };
    }

    const incident = body.event?.data || body.messages?.[0]?.incident;

    // Call Pulumi Deployments REST API
    const response = await fetch(
        `https://api.pulumi.com/api/stacks/${PULUMI_ORG}/${PULUMI_PROJECT}/${PULUMI_STACK}/deployments`,
        {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "Authorization": `token ${PULUMI_ACCESS_TOKEN}`,
            },
            body: JSON.stringify({
                operation: "update",
                inheritSettings: true,
                operationContext: {
                    environmentVariables: {
                        INCIDENT_ID: incident?.id || "unknown",
                        INCIDENT_TITLE: incident?.title || "unknown",
                        INCIDENT_URGENCY: incident?.urgency || "unknown",
                        INCIDENT_SERVICE: incident?.service?.summary || "unknown",
                    },
                },
            }),
        }
    );

    const result = await response.json();
    return {
        statusCode: response.ok ? 200 : 500,
        body: JSON.stringify({ status: response.ok ? "ok" : "error", deployment: result })
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
