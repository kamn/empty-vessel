// When System One's answer to a judging question stands, for the kernel's judge
// (src/tools/kernel-builtins.ts). Every question also offers System One UNCLEAR, so it can say it can't tell.

export type Choice = { readonly question: string; readonly options: Readonly<Record<string, string>> }
export const UNCLEAR = "The evidence shown doesn't settle it, or answering needs more than this evidence (e.g. following code into other files)"

// System One's answer to a question: one of its options, or "unsure" (then an LLM answers). Unsure when System One says it can't
// tell, and, on questions with two or three options (yes/no, a/b/tie), when its confidence is below 0.5: there it
// separates right from wrong (product_matching, 120 pairs: below 0.5, 5 of 14 right; 0.5 and up, 100 of 106).
// Never a bar on longer lists or scales: on a 0-4 rating System One's confidence (Jev's, measured) is 0.2-0.4 even within one point, and a bar
// (System Two's own sure: 0.7, since removed) threw most good ratings away. Fixed here, not chosen by System Two.
const DOUBTFUL_BELOW = 0.5
export const verdictFor = (choice: string, confidence: number, options: Readonly<Record<string, string>>) =>
  !(choice in options) ? "unsure"
  : Object.keys(options).length <= 3 && confidence < DOUBTFUL_BELOW ? "unsure"
  : choice

// The questions as System One is asked them: each with "can't tell" added.
export const withUnclear = (questions: Readonly<Record<string, Choice>>) =>
  Object.fromEntries(Object.entries(questions).map(([k, q]) => [k, { question: q.question, options: { ...q.options, unclear: UNCLEAR } }]))
