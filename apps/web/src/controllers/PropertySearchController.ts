import { ListingPresenter } from "../services/ListingPresenter";
import { ConversationRequests } from "../services/ConversationRequests";
import { CallbackFlowController, type CallerContext, type CallbackStage, type SimulatedCallbackRequest } from "./CallbackFlowController";
import { ListingNumberParser } from "../services/ListingNumberParser";
import { PortfolioGateway } from "../services/PortfolioGateway";
import { PropertyAnalysisGateway } from "../services/PropertyAnalysisGateway";
import type { CandidatePreview, RankedCandidate, StructuredClues } from "../types/PropertySearch";

export type PropertyAnalysisStatus = "idle" | "extracting" | "searching" | "ready" | "error";

export interface PropertyAnalysisState {
  turnId: number;
  status: PropertyAnalysisStatus;
  transcript: string;
  clues: StructuredClues | null;
  preview: CandidatePreview | null;
  assistantMessage: string | null;
  extractionMs: number | null;
  portfolioMs: number | null;
  totalMs: number | null;
  completedAt: number | null;
  error: string | null;
  callStage?: CallbackStage;
  callbackRequest?: SimulatedCallbackRequest | null;
}

export interface PropertySearchObserver {
  onState(state: PropertyAnalysisState): void;
}

interface ConversationLine {
  speaker: "Caller" | "Assistant";
  text: string;
}

interface QuestionOption {
  field: string;
  values: string[];
  priority: number;
}

const QUESTION_OPTIONS: QuestionOption[] = [
  { field: "transaction_type", values: [], priority: 8 },
  { field: "location", values: [], priority: 7 },
  { field: "property_type", values: [], priority: 6 },
  { field: "room_count", values: [], priority: 5 },
  { field: "floor_number", values: [], priority: 4 },
  { field: "nearby_feature", values: [], priority: 3 },
];

function normalize(text: string): string {
  return text
    .toLocaleLowerCase("tr-TR")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/ı/g, "i")
    .trim();
}

function isUnknownAnswer(text: string): boolean {
  return /\b(bilmiyorum|bilmiyor|bulamiyorum|bulamadim|bakamiyorum|hatirlamiyorum|hatirlayamiyorum|hatirlayamadim|tanimiyorum|emin degilim|aklimda degil|fikrim yok|no idea|not sure|i don't know|dont know)\b/.test(normalize(text));
}

function isPauseOrFiller(text: string): boolean {
  const phrase = normalize(text).replace(/[.! ,…?]+/g, " ").trim()
    .replace(/^(?:evet|tamam|tabii)\s+/, "");
  if (/^(?:hemen )?(?:bakayim|bakacagim|bakiyorum|kontrol edeyim|kontrol edecegim)$/.test(phrase)) return true;
  return /^(bir saniye|bi saniye|bir dakika|bekle|bekleyin|dur|durun|sey|eee+|hmm+|hihi|wait a second|one second|hold on|just a moment|give me a second)(?: (?:bakacagim|bakayim|bakiyorum|soyleyecegim|soyleyeyim|kontrol edeyim|kontrol edecegim|lutfen))?$/.test(phrase);
}

function isNegativeAnswer(text: string): boolean {
  return /^(hayir|yok|no|none|not really)[.! ,…]*$/.test(normalize(text));
}

function confirmationIntent(text: string): "yes" | "no" | "uncertain" {
  const phrase = normalize(text);
  if (/\b(hayir|bu degil|dogru degil|yanlis ilan|not this one|no)\b/.test(phrase)) return "no";
  if (isUnknownAnswer(text) || /\b(olmali|sanirim|galiba|belki|olabilir|herhalde|muhtemelen|dogru mu)\b/.test(phrase)) return "uncertain";
  if (!/\b(degil|yanlis)\b/.test(phrase) && /\b(evet|dogru|aynen|yes|that's it)\b/.test(phrase)) return "yes";
  return "uncertain";
}

function explicitDiscoveryChannel(conversation: ConversationLine[]): "sahibinden" | "afiş" | "diğer" | "bilinmiyor" {
  const callerText = normalize(conversation.filter((line) => line.speaker === "Caller").map((line) => line.text).join(" "));
  if (/\bsahibinden(?:\.com)?\b/.test(callerText)) return "sahibinden";
  if (/\b(afis\w*|tabela\w*|banner\w*|ilan panosu\w*)\b/.test(callerText)) return "afiş";
  if (/\b(instagram|facebook|google|web sitesi|internet sitesi|website)\b/.test(callerText)) return "diğer";
  return "bilinmiyor";
}

function explicitTransactionType(conversation: ConversationLine[]): "satılık" | "kiralık" | null {
  let value: "satılık" | "kiralık" | null = null;
  for (const line of conversation) {
    if (line.speaker !== "Caller") continue;
    const text = normalize(line.text);
    if (/bilmiyorum|hatirlamiyorum|emin degilim|satilik mi|kiralik mi/.test(text)) continue;
    const rent = /\bkiralik(?:ti|tir)?\b(?!\s+degil)/.test(text);
    const sale = /\bsatilik(?:ti|tir)?\b(?!\s+degil)/.test(text);
    if (rent !== sale) value = rent ? "kiralık" : "satılık";
  }
  return value;
}

function candidateValue(candidate: RankedCandidate, field: string): string {
  const listing = candidate.listing;
  switch (field) {
    case "consultant_name": return listing.consultant_name;
    case "location": return listing.location;
    case "transaction_type": return listing.transaction_type;
    case "property_type": return listing.property_type;
    case "room_count": return listing.room_count ?? "";
    case "floor_number": return listing.floor_number === null ? "" : String(listing.floor_number);
    case "nearby_feature": return listing.nearby_features.join(" / ");
    default: return "";
  }
}

function informationGain(values: string[]): number {
  const counts = new Map<string, number>();
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
  const count = values.length;
  return [...counts.values()].reduce((entropy, groupSize) => {
    const proportion = groupSize / count;
    return entropy - proportion * Math.log2(proportion);
  }, 0);
}

function formatCandidate(candidate: RankedCandidate): string {
  return ListingPresenter.summary(candidate.listing);
}

function questionFor(field: string): string {
  const questions: Record<string, string> = {
    listing_number: "İlanı Sahibinden'de gördüyseniz, ilan numarasını hatırlıyor musunuz?",
    consultant_name: "İlanla ilgilenen danışmanın adını hatırlıyor musunuz?",
    location: "Hangi ilçe ya da mahallede olduğunu hatırlıyor musunuz?",
    transaction_type: "İlan kiralık mıydı, satılık mıydı?",
    property_type: "Daire, villa ya da başka bir mülk türü müydü?",
    room_count: "Oda düzenini, örneğin 2+1 olduğunu hatırlıyor musunuz?",
    floor_number: "Kaçıncı katta olduğunu hatırlıyor musunuz?",
    nearby_feature: "Yakınında metro, park veya market gibi bir yer var mıydı?",
  };
  return questions[field] ?? "Mülkle ilgili bir ayrıntı daha paylaşabilir misiniz?";
}

export class PropertySearchController {
  private readonly analysis = new PropertyAnalysisGateway();
  private readonly portfolio = new PortfolioGateway();
  private readonly conversation: ConversationLine[] = [];
  private readonly askedFields = new Set<string>();
  private readonly answeredFields = new Set<string>();
  private readonly unavailableFields = new Set<string>();
  private readonly excludedListingNumbers = new Set<string>();
  private queue = Promise.resolve();
  private latestUtteranceId = 0;
  private lastQuestionField: string | null = null;
  private lastCandidateNumber: string | null = null;
  private pendingListingNumber = "";
  private listingNumberGuidanceGiven = false;
  private callbackFlow: CallbackFlowController | null = null;
  private lastClues: StructuredClues | null = null;
  private lastPreview: CandidatePreview | null = null;

  constructor(private readonly observer: PropertySearchObserver, private readonly callerContext: CallerContext = {}) {}

  resumeAfterInterruptedGoodbye(): void {
    this.callbackFlow?.resumeAfterInterruptedGoodbye();
  }

  addUtterance(utterance: string, turnId: number): void {
    const cleanUtterance = utterance.trim();
    if (!cleanUtterance || this.callbackFlow?.stage === "ended") return;

    this.conversation.push({ speaker: "Caller", text: cleanUtterance });

    if (isPauseOrFiller(cleanUtterance)) {
      if (!this.lastQuestionField && !this.callbackFlow) return;
      const assistantMessage = "Tabii, bekliyorum.";
      this.conversation.push({ speaker: "Assistant", text: assistantMessage });
      this.publish({
        turnId, status: "ready", transcript: this.formatConversation(), clues: this.lastClues,
        preview: this.lastPreview, assistantMessage, extractionMs: 0, portfolioMs: 0,
        totalMs: 0, completedAt: Date.now(), error: null,
      });
      return;
    }

    this.latestUtteranceId = turnId;
    const transcript = this.formatConversation();
    this.publish({ turnId, status: "extracting", transcript, clues: null, preview: null, assistantMessage: null, extractionMs: null, portfolioMs: null, totalMs: null, completedAt: null, error: null });
    this.queue = this.queue.then(() => this.handleUtterance(turnId, cleanUtterance));
  }

  private async handleUtterance(turnId: number, utterance: string): Promise<void> {
    const previousQuestionField = this.lastQuestionField;
    const totalStartedAt = performance.now();
    try {
      const expectingNumber = previousQuestionField === "listing_number";
      const declinesNumber = expectingNumber && /\b(istemiyorum|numarasiz|baska yoldan)\b/.test(normalize(utterance));
      const needsNumberHelp = ConversationRequests.listingNumberHelp(utterance, expectingNumber)
        || (expectingNumber && (isUnknownAnswer(utterance) || isNegativeAnswer(utterance)));
      if (needsNumberHelp || declinesNumber) {
        if ((expectingNumber && this.listingNumberGuidanceGiven) || declinesNumber) {
          this.unavailableFields.add("listing_number");
          this.pendingListingNumber = "";
          this.lastQuestionField = "consultant_name";
          this.askedFields.add("consultant_name");
          if (this.lastClues) {
            this.lastClues = { ...this.lastClues, listing_number: null, unavailable_fields: [...this.unavailableFields] };
          }
          this.replyWithoutAnalysis(turnId, "Sorun değil, başka bir yoldan ilerleyelim. İlanla ilgilenen danışmanın adını hatırlıyor musunuz?", totalStartedAt);
          return;
        }
        this.listingNumberGuidanceGiven = true;
        this.lastQuestionField = "listing_number";
        this.unavailableFields.delete("listing_number");
        this.replyWithoutAnalysis(turnId, "İlan numarasıyla doğru ilanı ve danışmanı hemen bulabiliriz. Sayfada kırmızı renkle yazan İlan No alanına bir kez bakabilir misiniz? İsterseniz bekleyebilirim.", totalStartedAt);
        return;
      }
      const matchedListing = this.lastPreview?.candidates.find((candidate) => candidate.listing.listing_number === this.lastCandidateNumber)?.listing;
      if (ConversationRequests.price(utterance) && matchedListing) {
        const consultant = matchedListing.consultant_name
          ? `Bu bilgi için ${matchedListing.consultant_name} size yardımcı olabilir.`
          : "Bu bilgi için ilanın danışmanı size yardımcı olabilir.";
        const nextQuestion = this.callbackFlow?.followUpQuestion() ?? "Aradığınız ilan bu mu?";
        this.replyWithoutAnalysis(turnId, `Elimdeki ilanda fiyat bilgisi bulunmuyor. ${consultant} ${nextQuestion}`, totalStartedAt);
        return;
      }
      if (ConversationRequests.listingDetails(utterance) && matchedListing) {
        const nextQuestion = this.callbackFlow?.followUpQuestion() ?? "Aradığınız ilan bu mu?";
        this.replyWithoutAnalysis(turnId, `Tabii. ${ListingPresenter.details(matchedListing)} ${nextQuestion}`, totalStartedAt);
        return;
      }
      if (ConversationRequests.repeat(utterance)) {
        const lastReply = [...this.conversation].reverse().find((line) => line.speaker === "Assistant");
        if (lastReply) {
          this.replyWithoutAnalysis(turnId, `Tabii, tekrar söyleyeyim. ${lastReply.text.replace(/^Tabii, tekrar söyleyeyim\. /, "")}`, totalStartedAt);
          return;
        }
      }
      if (this.callbackFlow) {
        this.replyWithoutAnalysis(turnId, this.callbackFlow.handle(utterance, confirmationIntent(utterance)), totalStartedAt);
        return;
      }

      if (previousQuestionField === "confirmation" && this.lastClues && this.lastCandidateNumber) {
        const intent = confirmationIntent(utterance);
        if (intent === "yes") {
          const listing = this.lastPreview?.candidates.find((candidate) => candidate.listing.listing_number === this.lastCandidateNumber)?.listing;
          if (!listing) throw new Error("The confirmed listing is no longer available.");
          this.callbackFlow = new CallbackFlowController(listing, this.callerContext);
          this.lastQuestionField = null;
          this.replyWithoutAnalysis(turnId, this.callbackFlow.start(), totalStartedAt);
          return;
        }
        if (intent === "uncertain") {
          this.replyWithoutAnalysis(turnId, `${matchedListing ? ListingPresenter.summary(matchedListing) + " " : ""}Aradığınız ilan bu mu? Evet veya hayır diyebilirsiniz.`, totalStartedAt);
          return;
        }
        this.excludedListingNumbers.add(this.lastCandidateNumber);
        // A rejected match does not erase the caller's earlier clues.
        const clues = { ...this.lastClues, listing_number: null };
        const portfolioStartedAt = performance.now();
        const preview = await this.portfolio.preview(clues, [...this.excludedListingNumbers]);
        this.lastClues = clues;
        this.lastPreview = preview;
        this.lastQuestionField = null;
        this.lastCandidateNumber = null;
        if (turnId !== this.latestUtteranceId) return;
        this.replyWithoutAnalysis(turnId, this.buildReply(clues, preview), totalStartedAt, performance.now() - portfolioStartedAt);
        return;
      }

      if (previousQuestionField && previousQuestionField !== "confirmation") {
        if (isUnknownAnswer(utterance)) {
          this.unavailableFields.add(previousQuestionField);
          if (previousQuestionField === "listing_number") this.pendingListingNumber = "";
          this.lastQuestionField = null;
        } else if (previousQuestionField === "nearby_feature" && isNegativeAnswer(utterance)) {
          this.answeredFields.add(previousQuestionField);
          this.lastQuestionField = null;
        }
      }

      const numberFragment = previousQuestionField === "listing_number"
        ? ListingNumberParser.parseFragment(utterance) : null;
      if (numberFragment) {
        // A caller can pause between groups, or repeat the complete number.
        this.pendingListingNumber = numberFragment.startsWith(this.pendingListingNumber)
          ? numberFragment : this.pendingListingNumber + numberFragment;
      }
      if (numberFragment && this.pendingListingNumber.length > ListingNumberParser.expectedLength) {
        this.pendingListingNumber = "";
        this.lastQuestionField = "listing_number";
        this.replyWithoutAnalysis(turnId, "Numarayı fazla haneli aldım. Sahibinden ilan numarasını 10 hane olacak şekilde baştan söyler misiniz?", totalStartedAt);
        return;
      }
      if (numberFragment && this.pendingListingNumber.length < ListingNumberParser.expectedLength) {
        this.lastQuestionField = "listing_number";
        this.replyWithoutAnalysis(turnId, `${this.pendingListingNumber} olarak aldım; ${this.pendingListingNumber.length} hane oldu. Toplam 10 hane gerekiyor. Devamını söyler misiniz?`, totalStartedAt);
        return;
      }
      const extraction = numberFragment && this.lastClues
        ? { clues: { ...this.lastClues }, elapsedMs: 0 }
        : await this.analysis.extract(this.formatCallerStatements());
      const clues = extraction.clues;
      if (numberFragment) {
        clues.listing_number = ListingNumberParser.parse(this.pendingListingNumber);
      }
      clues.discovery_channel = explicitDiscoveryChannel(this.conversation);
      clues.transaction_type = explicitTransactionType(this.conversation);
      if (previousQuestionField === "listing_number" && isUnknownAnswer(utterance)) clues.listing_number = null;
      if (clues.listing_number) {
        const digits = ListingNumberParser.parseFragment(clues.listing_number);
        if (!digits || digits.length !== ListingNumberParser.expectedLength) {
          clues.listing_number = null;
          this.lastClues = clues;
          this.lastPreview = null;
          this.pendingListingNumber = "";
          this.lastQuestionField = "listing_number";
          this.replyWithoutAnalysis(turnId, "İlan numarası 10 haneli olmalı. Numarayı baştan söyler misiniz?", totalStartedAt, 0, extraction.elapsedMs);
          return;
        }
        clues.listing_number = digits;
      }
      clues.unavailable_fields = [...new Set([...clues.unavailable_fields, ...this.unavailableFields])];
      if (previousQuestionField && !isUnknownAnswer(utterance) && this.fieldHasAnswer(previousQuestionField, clues)) {
        this.lastQuestionField = null;
      }
      this.publish({ turnId, status: "searching", transcript: this.formatConversation(), clues, preview: null, assistantMessage: null, extractionMs: extraction.elapsedMs, portfolioMs: null, totalMs: null, completedAt: null, error: null });

      const portfolioStartedAt = performance.now();
      const preview = await this.portfolio.preview(clues, [...this.excludedListingNumbers]);
      const portfolioMs = performance.now() - portfolioStartedAt;
      this.lastClues = clues;
      this.lastPreview = preview;

      // A caller may continue speaking while local model analysis is still running.
      // Do not answer a question that the caller has not heard yet; let the queued
      // utterance be analyzed with the complete caller-side conversation instead.
      if (turnId !== this.latestUtteranceId) return;

      const assistantMessage = this.buildReply(clues, preview);
      if (this.lastQuestionField !== "listing_number") this.pendingListingNumber = "";
      this.conversation.push({ speaker: "Assistant", text: assistantMessage });

      this.publish({
        turnId, status: "ready", transcript: this.formatConversation(), clues, preview, assistantMessage,
        extractionMs: extraction.elapsedMs, portfolioMs,
        totalMs: performance.now() - totalStartedAt, completedAt: Date.now(), error: null,
      });
    } catch (error) {
      if (turnId !== this.latestUtteranceId) return;
      this.publish({
        turnId, status: "error", transcript: this.formatConversation(), clues: null, preview: null,
        assistantMessage: null, extractionMs: null, portfolioMs: null, totalMs: performance.now() - totalStartedAt,
        completedAt: Date.now(), error: error instanceof Error ? error.message : "Property analysis could not be completed.",
      });
    }
  }

  private replyWithoutAnalysis(turnId: number, assistantMessage: string, startedAt: number, portfolioMs = 0, extractionMs = 0): void {
    this.conversation.push({ speaker: "Assistant", text: assistantMessage });
    this.publish({
      turnId, status: "ready", transcript: this.formatConversation(), clues: this.lastClues,
      preview: this.lastPreview, assistantMessage, extractionMs, portfolioMs,
      totalMs: performance.now() - startedAt, completedAt: Date.now(), error: null,
    });
  }

  private buildReply(clues: StructuredClues, preview: CandidatePreview): string {
    const exactCandidate = preview.candidates.find((item) => item.listing.listing_number === clues.listing_number);
    if (clues.listing_number && !exactCandidate) {
      const attemptedNumber = clues.listing_number;
      clues.listing_number = null;
      this.pendingListingNumber = "";
      this.lastQuestionField = "listing_number";
      return `${attemptedNumber} numaralı ilanı portföyümüzde bulamadım. 10 haneli numarayı kontrol edip baştan söyler misiniz?`;
    }
    const candidate = exactCandidate
      ?? preview.candidates.find((item) => item.listing.listing_number === preview.accepted_listing_number);
    if (candidate) {
      this.lastCandidateNumber = candidate.listing.listing_number;
      this.lastQuestionField = "confirmation";
      return `Olası bir ilan buldum: ${formatCandidate(candidate)} Aradığınız ilan bu mu?`;
    }

    this.lastCandidateNumber = null;
    if (this.lastQuestionField && this.lastQuestionField !== "confirmation") {
      const field = this.lastQuestionField;
      if (!this.unavailableFields.has(field) && !this.answeredFields.has(field) && !this.fieldHasAnswer(field, clues)) {
        return this.rephrasePendingQuestion(field);
      }
      this.lastQuestionField = null;
    }
    const knownFields = new Set([
      ...(clues.listing_number ? ["listing_number"] : []),
      ...(clues.consultant_name ? ["consultant_name"] : []),
      ...(clues.location ? ["location"] : []),
      ...(clues.address ? ["address", "location"] : []),
      ...(clues.transaction_type ? ["transaction_type"] : []),
      ...(clues.property_type ? ["property_type"] : []),
      ...(clues.room_count ? ["room_count"] : []),
      ...(clues.floor_number !== null ? ["floor_number"] : []),
      ...this.answeredFields,
    ]);
    const unavailable = new Set([...this.unavailableFields, ...clues.unavailable_fields]);

    let field: string | null = null;
    if (clues.discovery_channel === "bilinmiyor" && !unavailable.has("discovery_channel") && !this.askedFields.has("discovery_channel")) {
      field = "discovery_channel";
    } else if (clues.discovery_channel === "sahibinden" && !knownFields.has("listing_number") && !unavailable.has("listing_number") && !this.askedFields.has("listing_number")) {
      field = "listing_number";
    } else if ((clues.discovery_channel === "afiş" || unavailable.has("listing_number")) && !knownFields.has("consultant_name") && !unavailable.has("consultant_name") && !this.askedFields.has("consultant_name")) {
      field = "consultant_name";
    } else {
      const options = QUESTION_OPTIONS
        .filter((option) => !knownFields.has(option.field) && !unavailable.has(option.field) && !this.askedFields.has(option.field))
        .map((option) => ({
          ...option,
          values: [...new Set(preview.candidates.map((item) => candidateValue(item, option.field)).filter(Boolean))],
          entropy: informationGain(preview.candidates.map((item) => candidateValue(item, option.field)).filter(Boolean)),
        }))
        .filter((option) => option.values.length > 1 && option.entropy > 0)
        .sort((left, right) => right.priority - left.priority || right.entropy - left.entropy);
      field = options[0]?.field ?? null;
    }

    if (field) {
      this.askedFields.add(field);
      this.lastQuestionField = field;
      if (field === "discovery_channel") return "İlanı Sahibinden'de mi gördünüz, yoksa bir afişte mi?";
      return questionFor(field);
    }

    this.lastQuestionField = null;
    if (!preview.has_clues) {
      return "Aramaya başlayabilmem için bir ipucu gerekiyor. İlanı nerede gördüğünüzü hatırlıyor musunuz?";
    }
    return "Hâlâ birkaç olası ilan var. Sokak, oda düzeni, kat ya da yakındaki bir yer gibi başka bir ipucu seçenekleri daraltmaya yardımcı olabilir.";
  }

  private fieldHasAnswer(field: string, clues: StructuredClues): boolean {
    switch (field) {
      case "discovery_channel": return clues.discovery_channel !== "bilinmiyor";
      case "listing_number": return Boolean(clues.listing_number);
      case "consultant_name": return Boolean(clues.consultant_name);
      case "location": return Boolean(clues.location || clues.address);
      case "transaction_type": return Boolean(clues.transaction_type);
      case "property_type": return Boolean(clues.property_type);
      case "room_count": return Boolean(clues.room_count);
      case "floor_number": return clues.floor_number !== null;
      case "nearby_feature": return clues.other_clues.length > 0 || Boolean(clues.note.trim());
      default: return false;
    }
  }

  private rephrasePendingQuestion(field: string): string {
    if (field === "listing_number" && this.pendingListingNumber) {
      return `${this.pendingListingNumber} olarak aldım. Numaranın devamını söyler misiniz?`;
    }
    const questions: Record<string, string> = {
      discovery_channel: "Kaynağı netleştireyim: İlanı Sahibinden'de mi gördünüz, yoksa bir afişte mi?",
      listing_number: "Sahibinden'deki ilanın numarasını biliyor musunuz?",
      consultant_name: "İlanla ilgilenen danışmanın adını hatırlıyor musunuz?",
      location: "İlçe ya da mahalle adını hatırlıyor musunuz?",
      transaction_type: "İlan kiralık mıydı, satılık mıydı?",
      property_type: "Daire miydi, villa mıydı, başka bir mülk türü müydü?",
      room_count: "Oda düzenini, örneğin 2+1 olduğunu biliyor musunuz?",
      floor_number: "Kaçıncı katta olduğunu biliyor musunuz?",
      nearby_feature: "Yakınında metro, park veya market gibi bir yer var mıydı?",
      confirmation: "Bu, aradığınız ilan mı? Evet ya da hayır diyebilirsiniz.",
    };
    return questions[field] ?? "Bu bilgiyi netleştirebilir misiniz?";
  }

  private formatCallerStatements(): string {
    return this.conversation
      .filter((line) => line.speaker === "Caller" && !isPauseOrFiller(line.text))
      .map((line) => line.text)
      .join("\n");
  }

  private formatConversation(): string {
    return this.conversation.map((line) => `${line.speaker}: ${line.text}`).join("\n");
  }

  private publish(state: PropertyAnalysisState): void {
    this.observer.onState({
      ...state,
      callStage: this.callbackFlow?.stage,
      callbackRequest: this.callbackFlow?.callbackRequest ?? null,
    });
  }
}
