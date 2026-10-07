// Each preset changes the warm accents together; errors and syntax colours stay separate.
// Values are terminal 256-colour indexes, not RGB values.
export const themes = {
  orange: { accent: 209, step: 179, code: 216, number: 215 },
  blue: { accent: 75, step: 110, code: 117, number: 153 },
  green: { accent: 114, step: 108, code: 151, number: 157 },
  teal: { accent: 80, step: 73, code: 116, number: 122 },
} as const

export type ThemeName = keyof typeof themes

// Use teal unless config explicitly selects another preset.
export const DEFAULT_THEME: ThemeName = "teal"
