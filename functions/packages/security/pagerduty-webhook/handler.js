async function main(args) {
    const PULUMI_ACCESS_TOKEN = process.env.PULUMI_ACCESS_TOKEN;
    const PULUMI_ORG = process.env.PULUMI_ORG;
    const PULUMI_PROJECT = process.env.PULUMI_PROJECT;
    const PULUMI_STACK = process.env.PULUMI_STACK;

    // Parse PagerDuty webhook payload (V3 webhook format)
    const event = args.event?.event_type || args.messages?.[0]?.event;

    if (event !== "incident.triggered") {
        return {
            statusCode: 200,
            body: JSON.stringify({ status: "ignored", reason: "not a trigger event" })
        };
    }

    const incident = args.event?.data || args.messages?.[0]?.incident;

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

exports.main = main;
