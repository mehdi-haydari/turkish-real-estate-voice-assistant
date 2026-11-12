export type DiscoveryChannel = "sahibinden" | "afiş" | "diğer" | "bilinmiyor";

export interface StructuredClues {
  listing_number: string | null;
  discovery_channel: DiscoveryChannel;
  unavailable_fields: string[];
  transaction_type: "satılık" | "kiralık" | null;
  location: string | null;
  address: string | null;
  consultant_name: string | null;
  property_type: string | null;
  room_count: string | null;
  floor_number: number | null;
  other_clues: string[];
  note: string;
  next_question: string | null;
}

export interface ListingRecord {
  listing_number: string;
  transaction_type: "satılık" | "kiralık";
  location: string;
  address: string;
  property_type: string;
  room_count: string | null;
  floor_number: number | null;
  consultant_name: string;
  note: string;
  nearby_features: string[];
}

export interface RankedCandidate {
  listing: ListingRecord;
  score: number;
  acceptance_percent: number;
  field_scores: Record<string, number>;
  identity_matches: number;
  support_matches: number;
}

export interface CandidatePreview {
  candidates: RankedCandidate[];
  has_clues: boolean;
  consensus_fields: Record<string, string>;
  accepted_listing_number: string | null;
}
