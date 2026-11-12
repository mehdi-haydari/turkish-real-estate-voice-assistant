import type { CandidatePreview, StructuredClues } from "../types/PropertySearch";

export class PortfolioGateway {
  async preview(clues: StructuredClues, excludedListingNumbers: string[] = []): Promise<CandidatePreview> {
    const response = await fetch("/api/portfolio/v1/preview", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        listing_number: clues.listing_number,
        transaction_type: clues.transaction_type,
        location: clues.location,
        address: clues.address,
        consultant_name: clues.consultant_name,
        property_type: clues.property_type,
        room_count: clues.room_count,
        floor_number: clues.floor_number,
        other_clues: clues.other_clues,
        note: clues.note,
        excluded_listing_numbers: excludedListingNumbers,
      }),
    });

    if (!response.ok) throw new Error(`Portfolio search failed (${response.status}).`);
    return await response.json() as CandidatePreview;
  }
}
