"""Small local portfolio lookup prototype backed by disposable sample JSON."""

from __future__ import annotations

import json
import re
import unicodedata
from functools import lru_cache
from pathlib import Path
from typing import Literal

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field


app = FastAPI(title="Local Portfolio Lookup", version="0.1.0")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://127.0.0.1:8766"],
    allow_methods=["GET", "POST"],
    allow_headers=["Content-Type"],
)

SAMPLE_LISTINGS_PATH = Path(__file__).parent / "data" / "sample_listings.json"
ACCEPTANCE_THRESHOLD = 65


class Listing(BaseModel):
    listing_number: str
    transaction_type: Literal["satılık", "kiralık"]
    location: str
    address: str
    property_type: str
    room_count: str | None = None
    floor_number: int | None = None
    consultant_name: str
    note: str
    nearby_features: list[str] = Field(default_factory=list)


class SearchRequest(BaseModel):
    listing_number: str | None = None
    transaction_type: Literal["satılık", "kiralık"] | None = None
    location: str | None = None
    address: str | None = None
    consultant_name: str | None = None
    property_type: str | None = None
    room_count: str | None = None
    floor_number: int | None = None
    other_clues: list[str] = Field(default_factory=list)
    note: str | None = None
    excluded_listing_numbers: list[str] = Field(default_factory=list)


class SearchResponse(BaseModel):
    status: Literal["candidate_needs_confirmation", "not_found", "needs_clue", "ambiguous"]
    message: str
    customer_message: str | None = None
    match_method: Literal["listing_number", "clues"] | None = None
    listing: Listing | None = None
    acceptance_percent: int | None = None
    field_scores: dict[str, int] = Field(default_factory=dict)


class CandidatePreviewItem(BaseModel):
    listing: Listing
    score: int
    acceptance_percent: int
    field_scores: dict[str, int] = Field(default_factory=dict)
    identity_matches: int
    support_matches: int


class CandidatePreviewResponse(BaseModel):
    candidates: list[CandidatePreviewItem]
    has_clues: bool
    consensus_fields: dict[str, str] = Field(default_factory=dict)
    accepted_listing_number: str | None = None


@lru_cache(maxsize=1)
def _sample_listings() -> tuple[Listing, ...]:
    records = json.loads(SAMPLE_LISTINGS_PATH.read_text(encoding="utf-8"))
    return tuple(Listing.model_validate(record) for record in records)


def _normalize_listing_number(value: str) -> str:
    candidate = value.strip()
    if re.fullmatch(r"\d[\d\s.,-]*", candidate):
        return re.sub(r"\D", "", candidate)
    return candidate


def _normalize_room_count(value: str) -> str:
    return re.sub(r"\s+", "", value.casefold()).replace("×", "+")


def _clue_tokens(value: str) -> set[str]:
    normalized = unicodedata.normalize("NFKD", value.casefold().replace("ı", "i"))
    normalized = "".join(character for character in normalized if not unicodedata.combining(character))
    return set(re.findall(r"[a-z0-9]+", normalized))


def _clue_matches(query: str, record_value: str) -> bool:
    query_tokens = _clue_tokens(query)
    record_tokens = _clue_tokens(record_value)
    return bool(query_tokens and record_tokens and (query_tokens <= record_tokens or record_tokens <= query_tokens))


def _support_clue_matches(query: str, record_value: str) -> bool:
    if _clue_matches(query, record_value):
        return True
    query_tokens = _clue_tokens(query)
    record_tokens = _clue_tokens(record_value)
    overlap = query_tokens & record_tokens
    return len(overlap) >= 2 and len(overlap) / max(len(query_tokens), 1) >= 0.5


def _filter_by_explicit_transaction_type(records: list[Listing], request: SearchRequest) -> list[Listing]:
    if request.transaction_type:
        return [listing for listing in records if listing.transaction_type == request.transaction_type]
    return records


def _filter_by_explicit_consultant(records: list[Listing], request: SearchRequest) -> list[Listing]:
    if request.consultant_name:
        return [
            listing for listing in records
            if _clue_matches(request.consultant_name, listing.consultant_name)
        ]
    return records


def _candidate_score(listing: Listing, request: SearchRequest) -> tuple[int, int, int, dict[str, int]]:
    identity_matches = 0
    support_matches = 0
    field_scores: dict[str, int] = {}
    if request.location and (
        _clue_matches(request.location, listing.location)
        or _clue_matches(request.location, listing.address)
        or _support_clue_matches(request.location, listing.address)
    ):
        identity_matches += 1
        field_scores["location"] = 25
    if request.consultant_name and _clue_matches(request.consultant_name, listing.consultant_name):
        identity_matches += 1
        field_scores["consultant_name"] = 80
    if request.address and (
        _clue_matches(request.address, listing.address)
        or _support_clue_matches(request.address, listing.address)
    ):
        identity_matches += 1
        field_scores["address"] = 35
    if request.transaction_type and _clue_matches(request.transaction_type, listing.transaction_type):
        support_matches += 1
        field_scores["transaction_type"] = 25
    elif request.transaction_type:
        field_scores["transaction_type"] = -25
    if request.property_type and _clue_matches(request.property_type, listing.property_type):
        support_matches += 1
        field_scores["property_type"] = 15
    elif request.property_type:
        field_scores["property_type"] = -15
    if request.room_count and listing.room_count and _normalize_room_count(request.room_count) == _normalize_room_count(listing.room_count):
        support_matches += 1
        field_scores["room_count"] = 15
    elif request.room_count:
        field_scores["room_count"] = -15
    if request.floor_number is not None and listing.floor_number == request.floor_number:
        support_matches += 1
        field_scores["floor_number"] = 15
    elif request.floor_number is not None and listing.floor_number is not None:
        field_scores["floor_number"] = -20

    searchable_fields = (
        listing.location,
        listing.address,
        listing.transaction_type,
        listing.consultant_name,
        listing.property_type,
        listing.room_count or "",
        str(listing.floor_number) if listing.floor_number is not None else "",
        listing.note,
        *listing.nearby_features,
    )
    seen_other_clues: set[str] = set()
    structured_clues = [
        value for value in (
            request.transaction_type, request.location, request.address, request.consultant_name,
            request.property_type, request.room_count,
            str(request.floor_number) if request.floor_number is not None else None,
        ) if value
    ]
    supporting_clues = [*request.other_clues]
    if request.note and request.note.strip() and not any(
        _support_clue_matches(request.note, value) for value in structured_clues
    ):
        supporting_clues.append(request.note.strip())
    for clue in supporting_clues:
        normalized_clue = " ".join(sorted(_clue_tokens(clue)))
        if not normalized_clue or normalized_clue in seen_other_clues:
            continue
        seen_other_clues.add(normalized_clue)
        if any(_support_clue_matches(clue, value) for value in structured_clues):
            continue
        if any(_support_clue_matches(clue, field) for field in searchable_fields):
            support_matches += 1
            field_scores["other_clues"] = min(20, field_scores.get("other_clues", 0) + 10)

    # Field values are transparent heuristic contributions, not calibrated probabilities.
    acceptance_percent = max(0, min(100, sum(field_scores.values())))
    return acceptance_percent, identity_matches, support_matches, field_scores


def _candidate_response(
    listing: Listing,
    match_method: Literal["listing_number", "clues"],
    acceptance_percent: int,
    field_scores: dict[str, int],
) -> SearchResponse:
    if match_method == "listing_number":
        message = "Aday kayıt tam ilan numarasıyla eşleşti; arayanın onayı bekleniyor."
        lead_in = f"Kayda göre bu {listing.transaction_type} ilan {listing.location} konumunda."
        details = listing.note.strip()
        customer_message = f"{lead_in} Açık adresi: {listing.address}."
        if details:
            customer_message += f" {details}"
        customer_message += " Aradığınız ilan bu mu?"
    else:
        message = "İpuçlarıyla güçlü bir aday bulundu; arayanın ilanı doğrulaması bekleniyor."
        room_detail = f"{listing.room_count} " if listing.room_count else ""
        customer_message = (
            f"Bir ilan adayı buldum: {listing.location} konumunda {listing.transaction_type} "
            f"{room_detail}{listing.property_type}. Aradığınız ilan bu mu?"
        )
    return SearchResponse(
        status="candidate_needs_confirmation",
        message=message,
        customer_message=customer_message,
        match_method=match_method,
        listing=listing,
        acceptance_percent=acceptance_percent,
        field_scores=field_scores,
    )


@app.get("/health")
async def health() -> dict[str, str]:
    _sample_listings()
    return {"status": "ok"}


@app.post("/v1/preview", response_model=CandidatePreviewResponse)
async def preview_candidates(request: SearchRequest) -> CandidatePreviewResponse:
    excluded_numbers = {_normalize_listing_number(number) for number in request.excluded_listing_numbers}
    listing_number = _normalize_listing_number(request.listing_number) if request.listing_number else ""
    records = [listing for listing in _sample_listings() if listing.listing_number not in excluded_numbers]
    if listing_number:
        exact_records = [listing for listing in records if listing.listing_number == listing_number]
        if exact_records:
            exact_candidate = CandidatePreviewItem(
                listing=exact_records[0], score=90, acceptance_percent=90,
                field_scores={"listing_number": 90}, identity_matches=1, support_matches=0,
            )
            return CandidatePreviewResponse(
                candidates=[exact_candidate], has_clues=True,
                consensus_fields={"consultant_name": exact_records[0].consultant_name},
                accepted_listing_number=exact_records[0].listing_number,
            )
    records = _filter_by_explicit_transaction_type(records, request)
    records = _filter_by_explicit_consultant(records, request)
    has_clues = bool(
        listing_number
        or request.transaction_type
        or request.location
        or request.address
        or request.consultant_name
        or request.property_type
        or request.room_count
        or request.floor_number is not None
        or request.other_clues
        or request.note
    )
    ranked: list[CandidatePreviewItem] = []
    for listing in records:
        acceptance_percent, identity_matches, support_matches, field_scores = _candidate_score(listing, request)
        ranked.append(CandidatePreviewItem(
            listing=listing,
            score=acceptance_percent,
            acceptance_percent=acceptance_percent,
            field_scores=field_scores,
            identity_matches=identity_matches,
            support_matches=support_matches,
        ))
    ranked.sort(key=lambda candidate: (-candidate.score, candidate.listing.listing_number))
    matching = [candidate for candidate in ranked if candidate.score > 0]
    active_candidates = matching or ranked
    consultant_names = {candidate.listing.consultant_name for candidate in active_candidates}
    consensus_fields = {"consultant_name": next(iter(consultant_names))} if len(consultant_names) == 1 and consultant_names else {}
    accepted_listing_number = None
    if active_candidates:
        best_score = active_candidates[0].acceptance_percent
        best_candidates = [candidate for candidate in active_candidates if candidate.acceptance_percent == best_score]
        if best_score >= ACCEPTANCE_THRESHOLD and len(best_candidates) == 1:
            accepted_listing_number = best_candidates[0].listing.listing_number
    return CandidatePreviewResponse(
        candidates=active_candidates,
        has_clues=has_clues,
        consensus_fields=consensus_fields,
        accepted_listing_number=accepted_listing_number,
    )


@app.post("/v1/search", response_model=SearchResponse)
async def search_listing(request: SearchRequest) -> SearchResponse:
    excluded_numbers = {_normalize_listing_number(number) for number in request.excluded_listing_numbers}
    records = [
        listing
        for listing in _sample_listings()
        if listing.listing_number not in excluded_numbers
    ]
    listing_number = _normalize_listing_number(request.listing_number) if request.listing_number else ""
    if listing_number:
        number_matches = [listing for listing in records if listing.listing_number == listing_number]
        if len(number_matches) == 1:
            return _candidate_response(number_matches[0], "listing_number", 90, {"listing_number": 90})
        if len(number_matches) > 1:
            return SearchResponse(
                status="ambiguous",
                message="Bu ilan numarası birden fazla örnek kayıtta bulundu. Danışman adı veya açık adresle ayırt edelim.",
            )

    records = _filter_by_explicit_transaction_type(records, request)
    if not records and request.transaction_type:
        return SearchResponse(
            status="not_found",
            message=f"Örnek portföyde {request.transaction_type} ilan bulunmuyor.",
            acceptance_percent=0,
        )
    records = _filter_by_explicit_consultant(records, request)
    if not records and request.consultant_name:
        return SearchResponse(
            status="not_found",
            message=f"Örnek portföyde {request.consultant_name} danışmanına ait eşleşen ilan bulunmuyor.",
            acceptance_percent=0,
        )

    has_any_clues = bool(
        (request.transaction_type and request.transaction_type.strip())
        or (request.location and request.location.strip())
        or (request.address and request.address.strip())
        or (request.consultant_name and request.consultant_name.strip())
        or (request.property_type and request.property_type.strip())
        or (request.room_count and request.room_count.strip())
        or request.floor_number is not None
        or any(clue.strip() for clue in request.other_clues)
        or (request.note and request.note.strip())
    )
    if has_any_clues:
        scored_matches = []
        for listing in records:
            acceptance_percent, identity_matches, support_matches, field_scores = _candidate_score(listing, request)
            if identity_matches >= 1 or support_matches >= 2:
                scored_matches.append((acceptance_percent, field_scores, listing))
        if scored_matches:
            highest_score = max(score for score, _, _ in scored_matches)
            best_matches = [(fields, listing) for score, fields, listing in scored_matches if score == highest_score]
            if len(best_matches) == 1 and highest_score >= ACCEPTANCE_THRESHOLD:
                field_scores, best_listing = best_matches[0]
                return _candidate_response(best_listing, "clues", highest_score, field_scores)
            if len(best_matches) == 1:
                return SearchResponse(
                    status="needs_clue",
                    message=f"En iyi ilan adayı %{highest_score} uyum puanında; kabul eşiği %{ACCEPTANCE_THRESHOLD}. Bir ayırt edici ipucu daha gerekli.",
                    acceptance_percent=highest_score,
                    field_scores=best_matches[0][0],
                )
            return SearchResponse(
                status="ambiguous",
                message=f"Birden fazla ilan %{highest_score} uyum puanında eşleşiyor; tek kayıt için %{ACCEPTANCE_THRESHOLD} eşiğine ulaşmak yeterli değil.",
                acceptance_percent=highest_score,
                field_scores=best_matches[0][0],
            )

    if not listing_number and not has_any_clues:
        return SearchResponse(
            status="needs_clue",
            message="İlan numarası veya arama ipucu alınmadı. Danışman adı, satılık/kiralık bilgisi, adres ya da mülk türünden birini paylaşabilir misiniz?",
        )
    return SearchResponse(
        status="not_found",
        message="İlan numarası ve verilen ipuçlarıyla örnek portföyde eşleşme bulunamadı. Öncelikli ilan bilgilerinden başka birini paylaşabilir misiniz?",
        acceptance_percent=0,
    )
