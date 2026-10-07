import { Effect, Schema } from "effect"

// Settings that say what they are: every setting in config.json, the core's and each plugin's,
// is made with setting(): a description, and its default if it has one. A struct of settings (described()) only takes
// described ones, so an undescribed setting doesn't compile; undescribed() checks it at run time too (an outside plugin
// may be JavaScript). What values are allowed is the schema's own business (Literals, an Int's checks, Redacted for a
// secret), so a description says what the setting is for, not what it may be.

declare const isSetting: unique symbol
declare const isSettings: unique symbol
export type Setting<S extends Schema.Top = Schema.Top> = S & { readonly [isSetting]: true }
export type Settings<F extends Readonly<Record<string, Setting>> = Readonly<Record<string, Setting>>> = Schema.Struct<F> & { readonly [isSettings]: true }

// What a setting is: its description, its default (shown, e.g. by doctor), and for a group or a record of groups, the
// settings inside (`each`: one per key of a record, such as each source).
export type About = { readonly description: string; readonly default?: unknown; readonly fields?: Readonly<Record<string, Schema.Top>>; readonly each?: boolean }
const abouts = new WeakMap<object, About>()
export const aboutOf = (s: unknown) => (s && (typeof s === "object" || typeof s === "function") ? abouts.get(s) : undefined) // schemas are callable

// A setting: `default` is what a missing key decodes to (as Schema.withDecodingDefaultKey); `optional` leaves it out.
export function setting<S extends Schema.Top>(schema: S, description: string): Setting<S>
export function setting<S extends Schema.Top>(schema: S, description: string, options: { readonly default: S["Encoded"] }): Setting<Schema.withDecodingDefaultKey<S>>
export function setting<S extends Schema.Top>(schema: S, description: string, options: { readonly optional: true }): Setting<Schema.optionalKey<S>>
export function setting(schema: Schema.Top, description: string, options: { readonly default?: unknown; readonly optional?: true } = {}): Setting {
  const hasDefault = "default" in options
  const annotated = schema.annotate({ description, ...(hasDefault ? { default: options.default } : {}) })
  const made = hasDefault ? annotated.pipe(Schema.withDecodingDefaultKey(Effect.succeed(options.default))) : options.optional ? Schema.optionalKey(annotated) : annotated

  // What's inside, for undescribed(): a group's own settings, or those of every value of a record of groups.
  const inner = schema as { readonly fields?: Record<string, Schema.Top>; readonly value?: { readonly fields?: Record<string, Schema.Top> } }
  const fields = inner.fields ?? inner.value?.fields
  abouts.set(made, { description, ...(hasDefault ? { default: options.default } : {}), ...(fields ? { fields, each: !inner.fields } : {}) })
  return made as Setting
}

// A struct of described settings: a plugin's, or a group of the config's.
export const described = <F extends Readonly<Record<string, Setting>>>(fields: F) => Schema.Struct(fields) as Settings<F>

// A group of settings in config.json (`adoption`, `kernel.tools`): described itself; missing, every setting in it
// takes its default.
export const section = <F extends Readonly<Record<string, Setting>>>(fields: F, description: string) =>
  setting(described(fields), description, { default: {} as Settings<F>["Encoded"] })

// The settings in a struct that weren't made with setting(), by path ("adoption.sampler", "sources.*.url").
export const undescribed = (fields: Readonly<Record<string, Schema.Top>>, path = ""): ReadonlyArray<string> =>
  Object.entries(fields).flatMap(([key, field]) => {
    const about = aboutOf(field)
    const at = `${path}${key}`
    if (!about) return [at]
    return about.fields ? undescribed(about.fields, `${at}.${about.each ? "*." : ""}`) : []
  })

// A setting in words, for doctor: "model: what it is (default luna; one of a, b)".
export const explain = (fields: Readonly<Record<string, Schema.Top>>, key: string) => {
  const field = fields[key]
  const about = aboutOf(field)
  if (!field || !about) return undefined

  const json = (() => { try { return Schema.toJsonSchemaDocument(field).schema as { enum?: ReadonlyArray<unknown> } } catch { return {} } })()
  const extra = [
    ...(about.default !== undefined ? [`default ${JSON.stringify(about.default)}`] : []),
    ...(json.enum ? [`one of ${json.enum.join(", ")}`] : []),
  ]
  return `${key}: ${about.description}${extra.length ? ` (${extra.join("; ")})` : ""}`
}
