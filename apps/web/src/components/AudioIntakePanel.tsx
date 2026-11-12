import { VoiceReplyController, type VoiceReplyState } from "../controllers/VoiceReplyController";
import { useEffect, useRef, useState } from "react";
import { LiveSpeechController } from "../controllers/LiveSpeechController";
import { PropertySearchController, type PropertyAnalysisState } from "../controllers/PropertySearchController";
import type { SpeechStatus, TranscriptionTiming } from "../types/SpeechEvents";
import type { RankedCandidate, StructuredClues } from "../types/PropertySearch";

const STATUS_LABELS: Record<SpeechStatus, string> = {
  idle: "Ready",
  requesting_microphone: "Requesting microphone access",
  connecting: "Connecting to STT",
  listening: "Listening",
  speech_detected: "Speech detected",
  transcribing: "Transcribing speech",
  stopping: "Stopping",
  stopped: "Stopped",
  error: "Error",
};

interface TranscriptItem {
  id: number;
  text: string;
  timing?: TranscriptionTiming;
  createdAt: number;
  analysis?: PropertyAnalysisState;
  voice?: VoiceReplyState;
}

function formatSeconds(milliseconds: number): string {
  return `${(milliseconds / 1000).toFixed(2)} s`;
}

function median(values: number[]): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[middle - 1] + sorted[middle]) / 2
    : sorted[middle];
}

const FIELD_LABELS: Record<string, string> = {
  listing_number: "Listing number",
  location: "Location",
  address: "Address",
  consultant_name: "Consultant",
  transaction_type: "Sale or rent",
  property_type: "Property type",
  room_count: "Rooms",
  floor_number: "Floor",
  other_clues: "Other clues",
};

function clueEntries(clues: StructuredClues): Array<[string, string]> {
  const entries: Array<[string, string]> = [
    ["Source", clues.discovery_channel],
    ["Listing number", clues.listing_number ?? ""],
    ["Sale or rent", clues.transaction_type ?? ""],
    ["Location", clues.location ?? ""],
    ["Address", clues.address ?? ""],
    ["Consultant", clues.consultant_name ?? ""],
    ["Property type", clues.property_type ?? ""],
    ["Rooms", clues.room_count ?? ""],
    ["Floor", clues.floor_number === null ? "" : String(clues.floor_number)],
    ["Other clues", clues.other_clues.join(", ")],
  ];
  return entries.filter(([, value]) => Boolean(value));
}

function CandidateCard({ candidate, rank }: { candidate: RankedCandidate; rank: number }) {
  const propertySummary = [candidate.listing.room_count, candidate.listing.property_type]
    .filter(Boolean)
    .join(" ");
  const reasons = Object.entries(candidate.field_scores);

  return (
    <li className="candidate-card">
      <div className="candidate-heading">
        <strong>#{rank} · {candidate.listing.listing_number}</strong>
        <span>Heuristic score: {candidate.score}</span>
      </div>
      <p>{candidate.listing.transaction_type} {propertySummary} · {candidate.listing.location}</p>
      <p className="candidate-consultant">Consultant: {candidate.listing.consultant_name}</p>
      {reasons.length > 0 && (
        <ul className="evidence-list">
          {reasons.map(([field, score]) => (
            <li className={score < 0 ? "evidence--conflict" : "evidence--match"} key={field}>
              {FIELD_LABELS[field] ?? field}: {score > 0 ? `matches (+${score})` : `conflicts (${score})`}
            </li>
          ))}
        </ul>
      )}
    </li>
  );
}

function formatTime(timestamp: number): string {
  return new Date(timestamp).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

function formatChatForCopy(items: TranscriptItem[]): string {
  return items.map((item) => {
    const lines = [`Caller (${formatTime(item.createdAt)}):`, item.text];
    if (item.timing) {
      lines.push(
        `STT: ${formatSeconds(item.timing.transcription_ms)} processing` +
        (item.timing.endpointing_ms === null ? "" : `; VAD ${formatSeconds(item.timing.endpointing_ms)}`) +
        (item.timing.total_ms === null ? "" : `; estimated speech end to transcript ${formatSeconds(item.timing.total_ms)}`),
      );
    }

    if (item.voice) {
      lines.push(`Voice: ${item.voice.status}; request-to-audio ${item.voice.synthesisMs === null ? "pending" : formatSeconds(item.voice.synthesisMs)}; audio duration ${item.voice.audioDurationMs === null ? "unknown" : formatSeconds(item.voice.audioDurationMs)}`);
      if (item.voice.error) lines.push(`Voice error: ${item.voice.error}`);
      if (item.voice.playbackStartedAt && item.timing?.total_ms != null) lines.push(`Estimated speech end to voice: ${formatSeconds(item.voice.playbackStartedAt - item.createdAt + item.timing.total_ms)}`);
    }
    const analysis = item.analysis;
    if (!analysis) return lines.join("\n");
    lines.push(`Assistant (${analysis.completedAt ? formatTime(analysis.completedAt) : "processing"}):`);
    if (analysis.assistantMessage) lines.push(analysis.assistantMessage);
    if (analysis.error) lines.push(`Error: ${analysis.error}`);
    if (analysis.clues) {
      const clues = clueEntries(analysis.clues).map(([label, value]) => `${label}: ${value}`);
      if (clues.length) lines.push(`Understood clues: ${clues.join("; ")}`);
      if (analysis.clues.unavailable_fields.length) {
        lines.push(`Caller does not know: ${analysis.clues.unavailable_fields.join(", ")}`);
      }
    }
    if (analysis.preview?.has_clues) {
      lines.push(`Candidates (${analysis.preview.candidates.length} records considered):`);
      for (const [index, candidate] of analysis.preview.candidates.slice(0, 5).entries()) {
        const property = [candidate.listing.room_count, candidate.listing.property_type].filter(Boolean).join(" ");
        const evidence = Object.entries(candidate.field_scores).map(([field, score]) => `${field} ${score > 0 ? "+" : ""}${score}`).join(", ");
        lines.push(`${index + 1}. ${candidate.listing.listing_number}: ${candidate.listing.transaction_type} ${property}, ${candidate.listing.location}; score ${candidate.score}${evidence ? `; evidence ${evidence}` : ""}`);
      }
    }
    if (analysis.callStage) lines.push(`Call stage: ${analysis.callStage}`);
    if (analysis.callbackRequest) {
      const callback = analysis.callbackRequest;
      lines.push(`Simulated callback (no notification sent): ${callback.callerName}; phone ${callback.phone}; consultant ${callback.consultantName}; listing ${callback.listingNumber}`);
      if (callback.notes.length) lines.push(`Callback notes: ${callback.notes.join("; ")}`);
    }
    if (analysis.extractionMs !== null && analysis.totalMs !== null) {
      lines.push(`Analysis timing: model ${formatSeconds(analysis.extractionMs)}; portfolio ${formatSeconds(analysis.portfolioMs ?? 0)}; total ${formatSeconds(analysis.totalMs)}`);
    }
    return lines.join("\n");
  }).join("\n\n");
}

export function AudioIntakePanel() {
  const controllerRef = useRef<LiveSpeechController | null>(null);
  const voiceRef = useRef<VoiceReplyController | null>(null);
  const voiceEnabledRef = useRef(true);
  const endingTurnRef = useRef<number | null>(null);
  const callerTurnPendingRef = useRef(false);
  const callActiveRef = useRef(false);
  const [voiceEnabled, setVoiceEnabled] = useState(true);
  const nextTurnId = useRef(0);
  const callEndedRef = useRef(false);
  const resetCallRef = useRef<(() => void) | null>(null);
  const [status, setStatus] = useState<SpeechStatus>("idle");
  const [statusMessage, setStatusMessage] = useState("Ready");
  const [transcripts, setTranscripts] = useState<TranscriptItem[]>([]);
  const [copyStatus, setCopyStatus] = useState("");

  useEffect(() => {
    const voice = new VoiceReplyController({
      onState: (voiceState) => setTranscripts((previous) => previous.map((item) => (
        item.id === voiceState.turnId ? { ...item, voice: voiceState } : item
      ))),
      onFinished: (turnId, reason) => {
        if (endingTurnRef.current !== turnId) return;
        endingTurnRef.current = null;
        if (reason === "interrupted") {
          propertySearch.resumeAfterInterruptedGoodbye();
        } else {
          callEndedRef.current = true;
          controllerRef.current?.stop();
        }
      },
    });
    voiceRef.current = voice;
    const observer = {
      onState: (analysisState: PropertyAnalysisState) => {
        setTranscripts((previous) => previous.map((item) => (
          item.id === analysisState.turnId ? { ...item, analysis: analysisState } : item
        )));
        if (analysisState.status === "ready" && analysisState.assistantMessage) {
          if (voiceEnabledRef.current && callActiveRef.current && !callerTurnPendingRef.current) {
            if (analysisState.callStage === "ended") endingTurnRef.current = analysisState.turnId;
            voice.enqueue(analysisState.turnId, analysisState.assistantMessage);
          } else if (analysisState.callStage === "ended" && callerTurnPendingRef.current) {
            propertySearch.resumeAfterInterruptedGoodbye();
          } else if (analysisState.callStage === "ended") {
            callEndedRef.current = true;
            controllerRef.current?.stop();
          }
        }
      },
    };
    let propertySearch = new PropertySearchController(observer);
    resetCallRef.current = () => {
      propertySearch = new PropertySearchController(observer);
      callEndedRef.current = false;
      callerTurnPendingRef.current = false;
      endingTurnRef.current = null;
    };
    const speechController = new LiveSpeechController({
      onStatus: (nextStatus, message) => {
        if (nextStatus === "listening") callActiveRef.current = true;
        if (nextStatus === "stopped" || nextStatus === "error") callActiveRef.current = false;
        if (nextStatus === "speech_detected") {
          callerTurnPendingRef.current = true;
          voice.cancel("interrupted");
        }
        if (nextStatus === "listening" && message.startsWith("Short or unclear")) callerTurnPendingRef.current = false;
        setStatus(nextStatus);
        setStatusMessage(message);
      },
      onTranscript: (text, timing) => {
        if (callEndedRef.current) return;
        callerTurnPendingRef.current = false;
        const id = nextTurnId.current++;
        setTranscripts((previous) => [...previous, { id, text, timing, createdAt: Date.now() }]);
        propertySearch.addUtterance(text, id);
      },
    });
    controllerRef.current = speechController;
    return () => {
      voice.dispose();
      voiceRef.current = null;
      speechController.dispose();
      resetCallRef.current = null;
    };
  }, []);

  const isRunning = ["requesting_microphone", "connecting", "listening", "speech_detected", "transcribing"].includes(status);
  const fullyMeasured = transcripts.filter(
    (item) => item.timing?.total_ms !== null && item.timing?.total_ms !== undefined,
  );
  const measuredTotals = fullyMeasured.map((item) => item.timing!.total_ms!);
  const measuredEndpointing = fullyMeasured
    .map((item) => item.timing!.endpointing_ms)
    .filter((value): value is number => value !== null);
  const measuredProcessing = fullyMeasured.map((item) => item.timing!.transcription_ms);
  const medianTotal = median(measuredTotals);
  const medianEndpointing = median(measuredEndpointing);
  const medianProcessing = median(measuredProcessing);

  async function copyConversation(): Promise<void> {
    try {
      await navigator.clipboard.writeText(formatChatForCopy(transcripts));
      setCopyStatus("Chat copied");
    } catch {
      setCopyStatus("Could not access the clipboard");
    }
  }

  return (
    <main className="voice-app">
      <header className="page-header">
        <p className="eyebrow">Voice assistant prototype</p>
        <h1>Real estate call assistant</h1>
        <p>Speak naturally. The prototype transcribes the caller, extracts property clues, searches sample listings, and asks one question to narrow the results.</p>
      </header>

      <section className="panel" aria-labelledby="controls-title">
        <h2 id="controls-title">Microphone</h2>
        <div className="actions">
          <button
            className="button button--primary"
            disabled={isRunning}
            onClick={() => {
              if (callEndedRef.current) resetCallRef.current?.();
              void (async () => {
                if (voiceEnabledRef.current) await voiceRef.current?.enable();
                await controllerRef.current?.start();
              })().catch((error) => setStatusMessage(error instanceof Error ? error.message : "Could not enable audio."));
            }}
          >
            {callEndedRef.current ? "Start new call" : "Start listening"}
          </button>
          <button
            className="button button--secondary"
            disabled={!isRunning}
            onClick={() => {
              voiceRef.current?.cancel();
              controllerRef.current?.stop();
            }}
          >
            Stop
          </button>
        </div>
        <label>
          <input type="checkbox" checked={voiceEnabled} onChange={(event) => {
            const enabled = event.target.checked;
            setVoiceEnabled(enabled);
            voiceEnabledRef.current = enabled;
            if (enabled) void voiceRef.current?.enable().catch(() => setStatusMessage("Could not enable voice playback."));
            else voiceRef.current?.cancel();
          }} /> Voice replies · FreyaTTS
        </label>
        <p className={`status status--${status}`} role="status" aria-live="polite">
          <strong>{STATUS_LABELS[status]}:</strong> {statusMessage}
        </p>
      </section>

      <section className="panel" aria-labelledby="conversation-title">
        <div className="section-heading">
          <h2 id="conversation-title">Conversation</h2>
          <div className="copy-control">
            <button className="button button--secondary" disabled={!transcripts.length} onClick={() => void copyConversation()}>
              Copy chat
            </button>
            {copyStatus && <span role="status" aria-live="polite">{copyStatus}</span>}
          </div>
        </div>
        <p className="measurement-note">The estimated end of speech is the first quiet frame detected by VAD. The service then waits for the configured silence interval before transcription.</p>
        {medianTotal !== null && (
          <p className="latency-summary" role="status">
            Median over {measuredTotals.length} {measuredTotals.length === 1 ? "utterance" : "utterances"}: estimated end-to-transcript <strong>{formatSeconds(medianTotal)}</strong>
            {medianEndpointing !== null && <> · VAD endpointing <strong>{formatSeconds(medianEndpointing)}</strong></>}
            {medianProcessing !== null && <> · STT processing <strong>{formatSeconds(medianProcessing)}</strong></>}
          </p>
        )}
        {transcripts.length ? (
          <ol className="chat-list">
            {transcripts.map((item) => (
              <li className="chat-turn" key={item.id}>
                <article className="chat-bubble chat-bubble--caller">
                  <div className="chat-meta"><strong>Caller</strong><time dateTime={new Date(item.createdAt).toISOString()}>{formatTime(item.createdAt)}</time></div>
                  <p className="transcript-text">{item.text}</p>
                {item.timing && (
                  <p className="transcript-timing">
                    STT processing: {formatSeconds(item.timing.transcription_ms)}
                    {item.timing.endpointing_ms !== null && (
                      <> · VAD endpointing: {formatSeconds(item.timing.endpointing_ms)}</>
                    )}
                    {item.timing.total_ms !== null && <> · Estimated speech end to transcript: {formatSeconds(item.timing.total_ms)}</>}
                  </p>
                )}
                </article>

                {item.analysis && (
                  <article className="chat-bubble chat-bubble--assistant">
                    <div className="chat-meta"><strong>Assistant</strong>{item.analysis.completedAt && <time dateTime={new Date(item.analysis.completedAt).toISOString()}>{formatTime(item.analysis.completedAt)}</time>}</div>
                    {item.analysis.status === "extracting" && <p>Extracting property clues…</p>}
                    {item.analysis.status === "searching" && <p>Searching the sample portfolio…</p>}
                    {item.analysis.status === "error" && <p className="assistant-error">I couldn't analyze that turn: {item.analysis.error}</p>}
                    {item.analysis.assistantMessage && <p className="assistant-message">{item.analysis.assistantMessage}</p>}
                    {item.analysis.clues && clueEntries(item.analysis.clues).length > 0 && (
                      <div className="chat-detail-block">
                        <strong>Clues understood</strong>
                        <ul className="clue-chip-list">
                          {clueEntries(item.analysis.clues).map(([label, value]) => <li key={label}><span>{label}</span> {value}</li>)}
                        </ul>
                        {item.analysis.clues.unavailable_fields.length > 0 && (
                          <p className="unavailable-note">Caller does not know: {item.analysis.clues.unavailable_fields.join(", ")}</p>
                        )}
                      </div>
                    )}
                    {item.analysis.preview?.has_clues && item.analysis.preview.candidates.length > 0 && (
                      <div className="chat-detail-block">
                        <strong>Top listing candidates · {item.analysis.preview.candidates.length} records considered</strong>
                        <ol className="candidate-list">
                          {item.analysis.preview.candidates.slice(0, 3).map((candidate, index) => (
                            <CandidateCard candidate={candidate} rank={index + 1} key={candidate.listing.listing_number} />
                          ))}
                        </ol>
                        <p className="confirmation-note">Scores are heuristic, not probabilities. The caller must confirm a listing.</p>
                      </div>
                    )}
                    {item.analysis.callbackRequest && (
                      <div className="chat-detail-block">
                        <strong>Simulated callback · no notification sent</strong>
                        <p>{item.analysis.callbackRequest.callerName} · {item.analysis.callbackRequest.phone}</p>
                        <p>Consultant: {item.analysis.callbackRequest.consultantName || "Not assigned"} · Listing: {item.analysis.callbackRequest.listingNumber}</p>
                        {item.analysis.callbackRequest.notes.length > 0 && <p>Notes: {item.analysis.callbackRequest.notes.join("; ")}</p>}
                      </div>
                    )}
                    {item.analysis.callStage === "ended" && <p className="confirmation-note">{item.voice?.status === "generating" || item.voice?.status === "playing" ? "Ending call after goodbye…" : item.voice?.status === "cancelled" ? "Goodbye interrupted" : "Call ended"}</p>}
                    {item.voice && (
                      <p className="transcript-timing" role="status">
                        Voice: {item.voice.status}
                        {item.voice.synthesisMs !== null && <> · Request to audio: {formatSeconds(item.voice.synthesisMs)}</>}
                        {item.voice.audioDurationMs !== null && <> · Audio duration: {formatSeconds(item.voice.audioDurationMs)}</>}
                        {item.voice.playbackStartedAt && item.timing?.total_ms != null && <> · Estimated speech end to voice: {formatSeconds(item.voice.playbackStartedAt - item.createdAt + item.timing.total_ms)}</>}
                        {item.voice.error && <> · {item.voice.error}</>}
                      </p>
                    )}
                    {item.analysis.totalMs !== null && (
                      <p className="transcript-timing assistant-timing">
                        Model extraction: {formatSeconds(item.analysis.extractionMs ?? 0)} · Portfolio search: {formatSeconds(item.analysis.portfolioMs ?? 0)} · Assistant processing: {formatSeconds(item.analysis.totalMs)}
                      </p>
                    )}
                  </article>
                )}
              </li>
            ))}
          </ol>
        ) : (
          <p className="empty-state">No conversation yet. Start listening and speak to the assistant.</p>
        )}
      </section>
    </main>
  );
}
