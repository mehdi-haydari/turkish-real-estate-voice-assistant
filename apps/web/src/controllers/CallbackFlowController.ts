import { ConversationRequests } from "../services/ConversationRequests";
import { ListingNumberParser } from "../services/ListingNumberParser";
import type { ListingRecord } from "../types/PropertySearch";

export interface CallerContext {
  name?: string;
  phone?: string;
}

export type CallbackStage = "name" | "phone" | "verify_phone" | "anything_else" | "additional_request" | "ended";

export interface SimulatedCallbackRequest {
  listingNumber: string;
  consultantName: string;
  callerName: string;
  phone: string;
  notes: string[];
  status: "simulated";
  preparedAt: number;
}

type AnswerIntent = "yes" | "no" | "uncertain";

function normalize(text: string): string {
  return text.toLocaleLowerCase("tr-TR").normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "").replace(/ı/g, "i");
}

/** An in-memory callback simulation; no external notifications are sent. */
export class CallbackFlowController {
  stage: CallbackStage = "name";
  private name: string;
  private phone: string;
  private phoneFragments = "";
  private request: SimulatedCallbackRequest | null = null;

  constructor(private readonly listing: ListingRecord, caller: CallerContext = {}) {
    this.name = caller.name?.trim() ?? "";
    this.phone = caller.phone?.replace(/\D/g, "") ?? "";
    if (!/^\d{10,15}$/.test(this.phone)) this.phone = "";
  }

  get callbackRequest(): SimulatedCallbackRequest | null {
    return this.request ? { ...this.request, notes: [...this.request.notes] } : null;
  }

  start(): string {
    if (!this.name) {
      this.stage = "name";
      return "Doğru ilanı bulduk. Size geri dönüş yapabilmemiz için adınızı alabilir miyim?";
    }
    return this.askForPhoneOrPrepare();
  }

  handle(utterance: string, intent: AnswerIntent): string {
    switch (this.stage) {
      case "name": {
        const name = utterance.trim()
          .replace(/^(?:(?:benim\s+)?ad[ıi]m|(?:benim\s+)?ismim|ben)\s*[:,-]?\s*/iu, "")
          .replace(/[, ]+soyad[ıi]m\s+/iu, " ")
          .replace(/[.!?,]+$/g, "").trim();
        if (ConversationRequests.isQuestionOrRequest(utterance) || name.split(/\s+/).length > 4 ||
            !/^[\p{L}][\p{L}'’ -]{1,79}$/u.test(name) ||
            /^(evet|hayir|bilmiyorum|hatirlamiyorum|tamam|tesekkurler)$/i.test(normalize(name))) {
          return "Size nasıl hitap edebilirim? Lütfen adınızı söyler misiniz?";
        }
        this.name = name;
        return this.askForPhoneOrPrepare();
      }
      case "phone": {
        if (this.declinesPhone(utterance) || /^(hayir|yok|no)[.! ,]*$/.test(normalize(utterance).trim())) {
          return this.skipCallback();
        }
        const fragment = this.phoneFragment(utterance);
        if (!fragment) return "Telefon numaranızı rakam rakam veya kısa gruplar halinde söyler misiniz?";
        this.phoneFragments = fragment.startsWith(this.phoneFragments) ? fragment : this.phoneFragments + fragment;
        if (this.phoneFragments.length > 15) {
          this.phoneFragments = "";
          return "Numara fazla uzun oldu. Telefon numaranızı baştan alabilir miyim?";
        }
        if (this.phoneFragments.length < 10) return "Numaranın devamını söyler misiniz?";
        this.phone = this.phoneFragments;
        this.stage = "verify_phone";
        return `${this.phone.split("").join(" ")} olarak aldım. Telefon numaranız doğru mu?`;
      }
      case "verify_phone":
        if (this.declinesPhone(utterance)) return this.skipCallback();
        if (intent === "yes") return this.prepareCallback();
        if (intent === "no") {
          this.phone = "";
          this.phoneFragments = "";
          this.stage = "phone";
          return "Telefon numaranızı yeniden alabilir miyim?";
        }
        return "Telefon numarasını doğru aldım mı? Evet veya hayır diyebilirsiniz.";
      case "anything_else":
        // A caller who declined may later volunteer a number without being asked again.
        if (!this.request && this.phoneFragment(utterance)) {
          this.stage = "phone";
          return this.handle(utterance, intent);
        }
        if (intent === "no" || this.isGoodbye(utterance)) return this.endCall();
        this.stage = "additional_request";
        if (intent === "yes" && /^(evet|evet lutfen|tabii|olur)[.! ,]*$/.test(normalize(utterance).trim())) return "Tabii, başka hangi konuda yardımcı olabilirim?";
        return this.recordAdditionalRequest(utterance);
      case "additional_request":
        if (intent === "no" || this.isGoodbye(utterance)) return this.endCall();
        return this.recordAdditionalRequest(utterance);
      case "ended":
        return "İyi günler, hoşça kalın.";
    }
  }

  followUpQuestion(): string {
    switch (this.stage) {
      case "name": return "Adınızı alabilir miyim?";
      case "phone": return "Size ulaşabilmemiz için telefon numaranızı alabilir miyim?";
      case "verify_phone": return `${this.phone.split("").join(" ")} olarak aldığım telefon numaranız doğru mu?`;
      case "anything_else": return "Yardımcı olabileceğim başka bir konu var mı?";
      case "additional_request": return "Başka hangi konuda yardımcı olabilirim?";
      case "ended": return "";
    }
  }

  resumeAfterInterruptedGoodbye(): void {
    if (this.stage === "ended") this.stage = "additional_request";
  }

  private askForPhoneOrPrepare(): string {
    if (!this.phone) {
      this.stage = "phone";
      const introduction = this.listing.consultant_name
        ? `Bu ilandan sorumlu danışmanımız ${this.listing.consultant_name}.`
        : "Bu ilan için ilgili danışmanımız size geri dönüş yapacak.";
      return `Teşekkürler ${this.name}. ${introduction} Size ulaşabilmesi için telefon numaranızı alabilir miyim?`;
    }
    return this.prepareCallback();
  }

  private phoneFragment(utterance: string): string | null {
    const answer = utterance.trim()
      .replace(/^(?:evet|tabii|tamam)[\s,.;:]+/iu, "")
      .replace(/^(?:(?:cep\s+)?telefon(?:um|\s+numaram)?|numaram|numara)\s*[:,-]?\s*/iu, "")
      .replace(/^\+/, "");
    return ListingNumberParser.parseFragment(answer);
  }

  private declinesPhone(utterance: string): boolean {
    return /\b(soylemek istemiyorum|paylasmak istemiyorum|vermek istemiyorum|numarami vermem|istemiyorum|vazgectim)\b/.test(normalize(utterance));
  }

  private skipCallback(): string {
    this.phone = "";
    this.phoneFragments = "";
    this.request = null;
    this.stage = "anything_else";
    const consultant = this.listing.consultant_name
      ? `İlanın danışmanı ${this.listing.consultant_name}. ` : "";
    return `Anlıyorum. ${consultant}Danışmanımızın size geri dönüş yapabilmesi için tek iletişim yolumuz paylaşacağınız telefon numarası. Numaranız olmadan sizi arayamıyoruz. Yardımcı olabileceğim başka bir konu var mı?`;
  }

  private prepareCallback(): string {
    this.request = {
      listingNumber: this.listing.listing_number,
      consultantName: this.listing.consultant_name,
      callerName: this.name,
      phone: this.phone,
      notes: [],
      status: "simulated",
      preparedAt: Date.now(),
    };
    this.stage = "anything_else";
    const consultant = this.listing.consultant_name
      ? `Bu ilanla ${this.listing.consultant_name} ilgileniyor.`
      : "Bu ilan için ilgili danışmanımıza ulaşacağız.";
    return `Teşekkürler ${this.name}. ${consultant} Sizi en kısa sürede araması için geri arama talebinizi kendisine ileteceğim. Yardımcı olabileceğim başka bir konu var mı?`;
  }

  private recordAdditionalRequest(utterance: string): string {
    this.stage = "anything_else";
    if (!this.request) {
      return "Bu isteğiniz için ilgili danışmanla görüşmeniz gerekiyor. Yardımcı olabileceğim başka bir konu var mı?";
    }
    this.request.notes.push(utterance);
    return "Bu notunuzu da danışmana iletilecek geri arama talebine ekledim. Başka bir isteğiniz var mı?";
  }

  private isGoodbye(text: string): boolean {
    const phrase = normalize(text).replace(/[,.!?;]+/g, " ").replace(/\s+/g, " ").trim();
    return /^(?:(?:yok|hayir|bu kadar|baska yok|tesekkurler|tesekkur ederim|sag ol|sag olun|sagol|iyi gunler|hosca kal|gorusuruz)(?:\s+|$))+$/.test(phrase);

  }

  private endCall(): string {
    this.stage = "ended";
    return `Rica ederim ${this.name}. Görüşmeniz için teşekkürler. İyi günler, hoşça kalın.`;
  }
}
