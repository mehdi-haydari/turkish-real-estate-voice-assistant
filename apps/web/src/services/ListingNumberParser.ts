/** Normalize a listing-number answer without relying on the local language model. */
export class ListingNumberParser {
  static readonly expectedLength = 10;
  static parse(answer: string): string | null {
    const digits = this.parseFragment(answer);
    return digits && digits.length === this.expectedLength ? digits : null;
  }

  static parseFragment(answer: string): string | null {
    const text = answer.toLocaleLowerCase("tr-TR")
      .normalize("NFKD").replace(/[\u0300-\u036f]/g, "").replace(/ı/g, "i")
      .replace(/^(?:evet|tabii|tamam)[\s,.;:]+/, "")
      .replace(/^(?:ilan\s+(?:numarasi su|numarasi|no)|numarasi|numara)\s*[:;,.-]?\s*/, "")
      .trim();
    let digits: string;
    if (/^\d[\d\s,.;:\-–—]*$/.test(text)) {
      digits = text.replace(/\D/g, "");
    } else {
      const units: Record<string, number> = {
        sifir: 0, bir: 1, iki: 2, uc: 3, dort: 4, bes: 5,
        alti: 6, yedi: 7, sekiz: 8, dokuz: 9,
      };
      const tens: Record<string, number> = {
        on: 10, yirmi: 20, otuz: 30, kirk: 40, elli: 50,
        altmis: 60, yetmis: 70, seksen: 80, doksan: 90,
      };
      const groups: string[] = [];
      let pendingTens: number | null = null;
      for (const word of text.split(/[\s,.;:\-–—]+/).filter(Boolean)) {
        if (Object.prototype.hasOwnProperty.call(tens, word)) {
          if (pendingTens !== null) groups.push(String(pendingTens));
          pendingTens = tens[word];
        } else if (Object.prototype.hasOwnProperty.call(units, word)) {
          groups.push(String((pendingTens ?? 0) + units[word]));
          pendingTens = null;
        } else if (/^\d+$/.test(word)) {
          if (pendingTens !== null) groups.push(String(pendingTens));
          pendingTens = null;
          groups.push(word);
        } else {
          return null;
        }
      }
      if (pendingTens !== null) groups.push(String(pendingTens));
      digits = groups.join("");
    }
    return /^\d{1,24}$/.test(digits) ? digits : null;
  }
}
