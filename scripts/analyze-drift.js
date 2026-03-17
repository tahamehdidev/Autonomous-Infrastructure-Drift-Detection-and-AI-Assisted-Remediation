const OpenAI = require("openai");
const fs = require("fs");

async function analyzeDrift() {
  console.log("Starting OpenAI drift analysis...");

  // Read the terraform plan output
  const rawPlan = fs.readFileSync("plan_output.txt", "utf8");

  // Find the relevant section — skip Terraform's refresh noise
  const relevantStart = rawPlan.indexOf("Terraform will perform the following actions");
  const trimmedPlan = relevantStart !== -1
    ? rawPlan.substring(relevantStart)
    : rawPlan;

  // Cap at 8000 characters to stay within token limits
  const planOutput = trimmedPlan.substring(0, 8000);

  console.log(`Plan output length: ${planOutput.length} characters`);

  const client = new OpenAI.default({
    apiKey: process.env.OPENAI_API_KEY,
  });

  const prompt = `You are a senior DevOps engineer reviewing infrastructure drift detected by Terraform.

Infrastructure drift means someone or something changed live AWS infrastructure without going through Terraform. This is dangerous because it breaks the "Git as single source of truth" principle and can introduce security vulnerabilities, instability, or compliance violations.

Here is the Terraform plan output showing what has drifted:

<terraform_plan>
${planOutput}
</terraform_plan>

Analyze this drift and respond with ONLY a valid JSON object. No text before or after the JSON.

The JSON must have exactly these fields:
{
  "explanation": "Clear 2-3 sentence explanation of what changed and why it matters",
  "risk_level": "LOW" | "MEDIUM" | "HIGH",
  "risk_reasoning": "One sentence explaining why you assigned this risk level",
  "pr_description": "A markdown pull request description explaining the drift and proposed fix, suitable for a GitHub PR body",
  "slack_summary": "A single short sentence suitable for a Slack notification"
}

Risk level definitions:
- LOW: Non-security changes with minimal impact. Examples: tag changes, description updates, minor config tweaks. Safe to auto-remediate immediately.
- MEDIUM: Changes that affect behavior but are not immediate security risks. Examples: instance type changes, scaling config changes, timeout adjustments. Auto-remediate in dev, require approval in prod.
- HIGH: Changes that affect security posture, networking, or access controls. Examples: security group rule changes, IAM policy changes, public access changes, port openings. Never auto-remediate. Always require human review via PR.`;

  console.log("Sending plan to OpenAI for analysis...");

  const response = await client.chat.completions.create({
    model: "gpt-4o",
    max_tokens: 1024,
    messages: [{ role: "user", content: prompt }],
    response_format: { type: "json_object" },
  });

  const responseText = response.choices[0].message.content;
  console.log("OpenAI response received");

  // Parse the JSON response
  let analysis;
  try {
    analysis = JSON.parse(responseText);
  } catch {
    // Fallback: try to extract JSON using regex if parsing fails
    const jsonMatch = responseText.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      analysis = JSON.parse(jsonMatch[0]);
    } else {
      throw new Error("Could not parse JSON from OpenAI response");
    }
  }

  // Write each field to its own file for use in subsequent workflow steps
  fs.writeFileSync("drift_risk.txt", analysis.risk_level);
  fs.writeFileSync("drift_explanation.txt", analysis.explanation);
  fs.writeFileSync("drift_pr_description.txt", analysis.pr_description);
  fs.writeFileSync("drift_slack_summary.txt", analysis.slack_summary);
  fs.writeFileSync("drift_risk_reasoning.txt", analysis.risk_reasoning);

  // Write to GITHUB_OUTPUT for direct use in workflow conditionals
  const githubOutput = process.env.GITHUB_OUTPUT;
  if (githubOutput) {
    fs.appendFileSync(githubOutput, `risk_level=${analysis.risk_level}\n`);
  }

  console.log(`Risk level: ${analysis.risk_level}`);
  console.log(`Explanation: ${analysis.explanation}`);
  console.log("Analysis complete. Output files written.");
}

analyzeDrift().catch((error) => {
  console.error("OpenAI analysis failed:", error.message);

  // Write fallback files so the workflow never breaks due to AI failure
  fs.writeFileSync("drift_risk.txt", "HIGH");
  fs.writeFileSync("drift_explanation.txt", "AI analysis failed. Treating as HIGH risk out of caution.");
  fs.writeFileSync("drift_pr_description.txt", "## Drift Detected\n\nAI analysis was unavailable. Manual review required.");
  fs.writeFileSync("drift_slack_summary.txt", "Drift detected. AI analysis failed — defaulting to HIGH risk.");
  fs.writeFileSync("drift_risk_reasoning.txt", "Analysis failed — defaulting to HIGH risk as a safety measure.");

  if (process.env.GITHUB_OUTPUT) {
    fs.appendFileSync(process.env.GITHUB_OUTPUT, "risk_level=HIGH\n");
  }

  // Exit 0 so the pipeline continues even if AI fails
  process.exit(0);
});