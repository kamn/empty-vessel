export type TextPaste = { readonly label: string; readonly text: string }

export const isLargePaste = (text: string) => text.length > 1_000 || text.split("\n").length > 10

export const foldPaste = (text: string, pastes: ReadonlyArray<TextPaste>) => {
  if (!isLargePaste(text)) return { shown: text, pastes }

  const label = `[Text #${pastes.length + 1}]`

  return { shown: label, pastes: [...pastes, { label, text }] }
}

// Replace only labels in the input, not label-like text inside an expanded paste.
export const expandPastes = (input: string, pastes: ReadonlyArray<TextPaste>) =>
  input.replace(/\[Text #\d+\]/g, label => pastes.find(paste => paste.label === label)?.text ?? label)
