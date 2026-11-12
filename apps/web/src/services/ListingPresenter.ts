import type { ListingRecord } from "../types/PropertySearch";

export class ListingPresenter {
  static summary(listing: ListingRecord): string {
    const property = [listing.room_count, listing.property_type].filter(Boolean).join(" ");
    const floor = listing.floor_number === null ? "" : listing.floor_number === 0 ? " Zemin katta." : ` ${listing.floor_number}. katta.`;
    return `${listing.location} konumunda ${listing.transaction_type} ${property}.${floor}`;
  }

  static details(listing: ListingRecord): string {
    return [
      `${listing.listing_number} numaralı ilan: ${this.summary(listing)}`,
      listing.address ? `Adresi: ${listing.address}.` : "",
      listing.note,
      listing.nearby_features.length ? `Yakınında ${listing.nearby_features.join(", ")} bulunuyor.` : "",
      listing.consultant_name ? `İlandan ${listing.consultant_name} sorumlu.` : "",
    ].filter(Boolean).join(" ");
  }
}
