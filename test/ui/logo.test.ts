import { expect, test } from "bun:test"
import { logo } from "../../src/ui/logo"

test("the startup logo matches the supplied artwork", () => {
  const rows = logo(0, false).split("\n").slice(1, 17)
  const expected = `             @@@@@@:+@@*            
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

  expect(rows.join("\n")).toBe(expected)
})

test("all rotating colours preserve the logo outline", () => {
  for (let turn = 0; turn < 6; turn++) {
    const plain = logo(turn, false, "orange")
    const colored = logo(turn, true, "orange").replace(/\x1b\[[0-9;]*m/g, "")
    expect(colored).toBe(plain)
  }
})
