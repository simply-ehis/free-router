const BASE = process.env.JEV_URL ?? 'https://opencode.ai/zen/v1/systemone';

async function tryBody(label, body) {
  try {
    const t0 = Date.now();
    const r = await fetch(BASE, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(8000),
    });
    const text = await r.text();
    console.log(`\n== ${label} -> ${r.status} (${Date.now() - t0}ms)`);
    console.log(text.slice(0, 1500));
  } catch (err) {
    console.log(`\n== ${label} -> ERROR ${err.message}`);
  }
}

await tryBody('all three types keyless', {
  model: 'jev-1.13-free',
  state: { messages: [{ role: 'user', content: 'Write a recursive fibonacci in rust with memoization and benchmarks' }] },
  questions: {
    complexity: {
      type: 'score',
      instructions: 'How complex is this coding request?',
      criteria: ['Trivial one-liner', 'Simple routine task', 'Moderate multi-step work', 'Hard expert-level task'],
    },
    cause: {
      type: 'choice',
      instructions: 'What caused this upstream failure?',
      criteria: {
        ratelimit: 'Too many requests / quota exhausted',
        model_dead: 'Model removed or endpoint gone',
        billing: 'Insufficient balance',
        transient: 'Temporary network or server error',
      },
    },
    justified: {
      type: 'noul',
      instructions: 'Is this tool call justified by the conversation?',
    },
  },
});
