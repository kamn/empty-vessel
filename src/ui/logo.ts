import { DEFAULT_THEME, themes, type ThemeName } from "./tui/theme"

// The empty vessel: a round bowl, ink pooled in its lower half, split by one vertical stroke.
// Shown when empty-vessel starts in interactive mode.
const ENSO = `
             @@@@@@:+@@*            
          @@@+    -     ::@         
        @@@      -+         @       
      @@@@       -+           #     
     @@@#        :.           .+    
    @@@@         *@##          :-   
   .@@@*      -*:   @@@@@       -   
   #@@@:     =-       @@@@@     =   
   %@@@@     -:       @@@@@@    =   
   #@@@@@     -      @@@@@@@    =.  
    @@@@@@@*     :@@@@@@@@@@-  :=   
    %@@@@@@@@@@@@@@@@@@@@@@@   -    
     -@@@@@@@@@@@ @@@@@@@@@  .%     
       @@@@@@@@@@ @@@@@@@@  :=      
         @@@@@@@@ @@@@@@   *        
               #@ #                 `

// Colour by how dense a mark is (wet brush vs dry): one 256-colour code per character, densest first.
const byInk = (codes: ReadonlyArray<number>) => (ch: string) => codes["@%#*+=-:.".indexOf(ch)] ?? codes.at(-1)!

// The palettes it rotates through, one per start. Each gives a mark's colour from the mark and where it is.
const PALETTES: ReadonlyArray<(ch: string, row: number, col: number) => number> = [
  () => 209,                                                        // empty-vessel's accent orange
  byInk([255, 252, 249, 246, 243, 241, 239, 237, 236]),             // sumi ink: bright wet marks, dim dry ones
  (_, row, col) => {                                                // brush stroke: gold drying to deep red along it
    const t = ((Math.PI * 1.25 - Math.atan2(6 - row, (col - 15) / 2.1)) % (2 * Math.PI) + 2 * Math.PI) % (2 * Math.PI) / (2 * Math.PI)
    return [220, 214, 208, 202, 196, 160, 124, 88][Math.floor(t * 8)]!
  },
  (_, row) => [221, 215, 209, 203, 204, 205, 169, 133, 97, 97, 61, 61, 61][row] ?? 61, // sunrise, top to bottom
  byInk([131, 95, 95, 89, 89, 53, 52, 234, 234]),                   // 玄 xuán: "dark, and darker still", lacquer red-black
  byInk([79, 73, 72, 36, 30, 29, 23, 23, 23]),                      // 青 qīng: jade to deep teal
]

const fg = (code: number, text: string) => `\x1b[38;5;${code}m${text}\x1b[0m`

// The logo in the palette for this start (`turn` counts starts; it wraps round), or plain when colour is off.
export const logo = (turn: number, color: boolean, theme: ThemeName = DEFAULT_THEME) => {
  const accent = themes[theme].accent
  const paint = theme === "orange" ? PALETTES[turn % PALETTES.length]! : () => accent
  const art = color ? ENSO.split("\n").map((line, row) => [...line].map((ch, col) => (ch === " " ? ch : fg(paint(ch, row - 1, col), ch))).join("")).join("\n") : ENSO
  return `${art}\n\n        ${color ? fg(accent, "無極") : "無極"} · empty-vessel\n`
}
