function normalize(text: string): string {
  return text.toLocaleLowerCase("tr-TR").normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "").replace(/ı/g, "i");
}

export class ConversationRequests {
  static listingNumberHelp(text: string, expectingListingNumber = false): boolean {
    const phrase = normalize(text);
    return (expectingListingNumber || /ilan\s+(?:no|numara)/.test(phrase))
      && /nerede|nereye|nasil|bulam|bulun|yaziyor|gorem|gormuyorum|goster/.test(phrase);
  }

  static repeat(text: string): boolean {
    return /duyamadim|duymadim|anlamadim|ne dediniz|tekrar(?:dan)?|bir (?:kere|kez) daha|bir kere de|yeniden soyler/.test(normalize(text));
  }

  static price(text: string): boolean {
    return /fiyat|ucret|bedel|kac para|ne kadar/.test(normalize(text));
  }

  static isQuestionOrRequest(text: string): boolean {
    return this.price(text) || this.listingDetails(text) || this.listingNumberHelp(text)
      || /[?]|\b(istiyorum|istiyordum|soruyorum|soracaktim|bilmiyorum|soyleyin|soyleyebilir|yardim|neden|nerede|nasil)\b/.test(normalize(text));
  }

  static listingDetails(text: string): boolean {
    const phrase = normalize(text);
    return /(?:ilan|daire|evin|mulk).*(?:detay|ozellik|hangisi|bilgi|anlat|acikla|soyle|tarif|nerede|adres)|(?:detay|ozellik|hangisi|bilgi).*(?:ilan|daire|mulk)|adresi ne|kacinci kat|kac oda/.test(phrase);
  }
}
