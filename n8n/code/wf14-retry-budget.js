// Up to three kill attempts within one execution, then escalate to a human.
const MAX_ATTEMPTS = 3;
const v = $input.first().json;
const attempt = $runIndex + 1;
return [{ json: { ...v, attempt, retry: attempt < MAX_ATTEMPTS } }];
