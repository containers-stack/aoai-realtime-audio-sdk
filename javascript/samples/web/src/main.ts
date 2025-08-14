// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { Player } from "./player.ts";
import { Recorder } from "./recorder.ts";
import { CircularAudioVisualizer } from "./visualizer.ts";
import "./style.css";
import { LowLevelRTClient, SessionUpdateMessage, Voice } from "rt-client";

let realtimeStreaming: LowLevelRTClient;
let audioRecorder: Recorder;
let audioPlayer: Player;
let audioVisualizer: CircularAudioVisualizer;

// Cache for product data loaded from /products.json
let productData: Record<string, { prompt: string; promptFile?: string }> | null = null;
const productPromptCache: Record<string, string> = {};

async function ensureProductDataLoaded() {
  if (productData) return;
  try {
    const res = await fetch("/products.json", { cache: "no-cache" });
    if (res.ok) {
      productData = await res.json();
    } else {
      console.warn("Failed to load products.json:", res.status, res.statusText);
      productData = {};
    }
  } catch (e) {
    console.warn("Error loading products.json", e);
    productData = {};
  }
}

// Populate the product dropdown from the JSON so adding products is config-only
async function populateProductDropdown() {
  await ensureProductDataLoaded();
  if (!productData) return;
  const current = formProductSelection.value;
  formProductSelection.innerHTML = "";
  const empty = document.createElement("option");
  empty.value = "";
  empty.textContent = "";
  formProductSelection.appendChild(empty);
  Object.keys(productData)
    .sort((a, b) => a.localeCompare(b))
    .forEach((name) => {
      const opt = document.createElement("option");
      opt.value = name;
      opt.textContent = name;
      formProductSelection.appendChild(opt);
    });
  if (current && productData[current]) {
    formProductSelection.value = current;
  }
}

async function start_realtime(endpoint: string, apiKey: string, deploymentOrModel: string) {
    realtimeStreaming = new LowLevelRTClient(new URL(endpoint), { key: apiKey }, { deployment: deploymentOrModel });

  try {
    console.log("sending session config");
    await ensureProductDataLoaded();
    await realtimeStreaming.send(await createConfigMessage());
  } catch (error) {
    console.log(error);
    makeNewTextBlock("[Connection error]: Unable to send initial config message. Please check your endpoint and authentication details.");
    setFormInputState(InputState.ReadyToStart);
    return;
  }
  console.log("sent");
  await Promise.all([resetAudio(true), handleRealtimeMessages()]);
}

async function getProductPrompt(product: string): Promise<string | null> {
  await ensureProductDataLoaded();
  const meta = productData?.[product];
  if (!meta) return null;

  // 1) Prefer inline prompt if provided
  if (meta.prompt && meta.prompt.trim().length > 0) {
    return meta.prompt.trim();
  }

  // 2) Otherwise, load from promptFile if provided
  const file = meta.promptFile;
  if (!file) return null;
  if (productPromptCache[file]) return productPromptCache[file];

  try {
    const res = await fetch(`/product-prompts/${file}`, { cache: "no-cache" });
    if (!res.ok) return null;
    const text = (await res.text()).trim();
    productPromptCache[file] = text;
    return text;
  } catch {
    return null;
  }
}

async function createConfigMessage() : Promise<SessionUpdateMessage> {

  let configMessage : SessionUpdateMessage = {
    type: "session.update",
    session: {
      turn_detection: {
        type: "server_vad",
      },
      input_audio_transcription: {
        model: "whisper-1"
      }
    }
  };

  let temperature = 1;
  const envTemp = import.meta.env.VITE_GENERAL_TEMPERATURE;
  if (envTemp !== undefined && !isNaN(parseFloat(envTemp))) {
    temperature = parseFloat(envTemp);
  }
  const voice = getVoice();
  const product = getProductTopic();

  // Base system message for customer role-play - emphasize customer role
  let baseInstructions = "You are a CUSTOMER looking to buy a tennis racket. You are NOT a salesperson. The human is the salesperson who will help you. Ask questions, express your needs, and let them guide you to find the right racket. Do not provide product information - ask for it instead. Start the conversation by explaining what you're looking for.";

  if (product) {
    const productPrompt = await getProductPrompt(product);
    if (productPrompt) {
      // Use the product-specific customer persona
      baseInstructions = productPrompt;
    } else {
      // Fallback if no product prompt is found
      baseInstructions += ` You are specifically interested in learning about the ${product}. Ask the salesperson to tell you about it.`;
    }
  }

  configMessage.session.instructions = baseInstructions;
  configMessage.session.temperature = temperature;
  if (voice) {
    configMessage.session.voice = voice;
  }

  return configMessage;
}

async function handleRealtimeMessages() {
  for await (const message of realtimeStreaming.messages()) {
    let consoleLog = "" + message.type;

    switch (message.type) {
      case "session.created":
        setFormInputState(InputState.ReadyToStop);
        const selectedProduct = getProductTopic();
        if (selectedProduct) {
          makeNewTextBlock(`<< Session Started - Customer interested in ${selectedProduct} >>`);
        } else {
          makeNewTextBlock("<< Session Started - Customer browsing tennis rackets >>");
        }
        makeNewTextBlock();
        break;
      case "response.audio_transcript.delta":
        appendToTextBlock(message.delta);
        break;
      case "response.audio.delta":
        const binary = atob(message.delta);
        const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
        const pcmData = new Int16Array(bytes.buffer);
        audioPlayer.play(pcmData);
        break;

      case "input_audio_buffer.speech_started":
        makeNewTextBlock("<< Speech Started >>");
        let textElements = formReceivedTextContainer.children;
        latestInputSpeechBlock = textElements[textElements.length - 1];
        makeNewTextBlock();
        audioPlayer.clear();
        break;
      case "conversation.item.input_audio_transcription.completed":
        latestInputSpeechBlock.textContent += " User: " + message.transcript;
        break;
      case "response.done":
        formReceivedTextContainer.appendChild(document.createElement("hr"));
        break;
      default:
        consoleLog = JSON.stringify(message, null, 2);
        break
    }
    if (consoleLog) {
      console.log(consoleLog);
    }
  }
  resetAudio(false);
}

/**
 * Basic audio handling
 */

let recordingActive: boolean = false;
let buffer: Uint8Array = new Uint8Array();

function combineArray(newData: Uint8Array) {
  const newBuffer = new Uint8Array(buffer.length + newData.length);
  newBuffer.set(buffer);
  newBuffer.set(newData, buffer.length);
  buffer = newBuffer;
}

function processAudioRecordingBuffer(data: Buffer) {
  const uint8Array = new Uint8Array(data);
  combineArray(uint8Array);
  if (buffer.length >= 4800) {
    const toSend = new Uint8Array(buffer.slice(0, 4800));
    buffer = new Uint8Array(buffer.slice(4800));
    const regularArray = String.fromCharCode(...toSend);
    const base64 = btoa(regularArray);
    if (recordingActive) {
      realtimeStreaming.send({
        type: "input_audio_buffer.append",
        audio: base64,
      });
    }
  }

}

async function resetAudio(startRecording: boolean) {
  recordingActive = false;
  if (audioRecorder) {
    audioRecorder.stop();
  }
  if (audioPlayer) {
    audioPlayer.clear();
  }
  if (audioVisualizer) {
    audioVisualizer.stop();
  }
  audioRecorder = new Recorder(processAudioRecordingBuffer);
  audioPlayer = new Player();
  audioPlayer.init(24000);
  if (startRecording) {
    stopIdleAnimation();
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    console.log('Got media stream:', stream, 'Active tracks:', stream.getAudioTracks().length);
    audioRecorder.start(stream);
    recordingActive = true;
    
    // Initialize visualizer with the same audio stream
    await audioVisualizer.initializeWithStream(stream);
  } else {
    // Start idle animation when not recording
    startIdleAnimation();
  }
}

/**
 * UI and controls
 */

const formReceivedTextContainer = document.querySelector<HTMLDivElement>(
  "#received-text-container",
)!;
const formStartButton =
  document.querySelector<HTMLButtonElement>("#start-recording")!;
const formStopButton =
  document.querySelector<HTMLButtonElement>("#stop-recording")!;
const formTestVisualizerButton =
  document.querySelector<HTMLButtonElement>("#test-visualizer")!;
const formClearAllButton =
  document.querySelector<HTMLButtonElement>("#clear-all")!;
// const formSessionInstructionsField =
//   document.querySelector<HTMLTextAreaElement>("#session-instructions")!;
const formVoiceSelection = document.querySelector<HTMLSelectElement>("#voice")!;
const formProductSelection = document.querySelector<HTMLSelectElement>("#product-topic")!;

// Initialize visualizer
const visualizerCanvas = document.querySelector<HTMLCanvasElement>("#audio-visualizer")!;
audioVisualizer = new CircularAudioVisualizer(visualizerCanvas);

// Start idle animation
let idleAnimationId: number;
function startIdleAnimation() {
  const animate = () => {
    if (!recordingActive) {
      audioVisualizer.drawIdleState();
      idleAnimationId = requestAnimationFrame(animate);
    }
  };
  animate();
}

function stopIdleAnimation() {
  if (idleAnimationId) {
    cancelAnimationFrame(idleAnimationId);
  }
}

// Start idle animation initially
startIdleAnimation();

let latestInputSpeechBlock: Element;

enum InputState {
  Working,
  ReadyToStart,
  ReadyToStop,
}

function setFormInputState(state: InputState) {
  formStartButton.disabled = state != InputState.ReadyToStart;
  formStopButton.disabled = state != InputState.ReadyToStop;
  // formSessionInstructionsField.disabled = state != InputState.ReadyToStart;
  formProductSelection.disabled = state != InputState.ReadyToStart;
}

function getVoice(): Voice {
  return formVoiceSelection.value as Voice;
}

function getProductTopic(): string {
  return formProductSelection.value || "";
}

function makeNewTextBlock(text: string = "") {
  let newElement = document.createElement("p");
  newElement.textContent = text;
  formReceivedTextContainer.appendChild(newElement);
}

function appendToTextBlock(text: string) {
  let textElements = formReceivedTextContainer.children;
  if (textElements.length == 0) {
    makeNewTextBlock();
  }
  textElements[textElements.length - 1].textContent += text;
}

// --- Modal controls & transcript analysis ---
const analysisModal = document.getElementById("analysis-modal") as HTMLDivElement | null;
const closeModalBtn = document.getElementById("close-modal") as HTMLButtonElement | null;
const analyzeBtn = document.getElementById("analyze-transcript") as HTMLButtonElement | null;
const modalClearDisplayBtn = document.getElementById("clear-display") as HTMLButtonElement | null;
const insightsLoadingEl = document.getElementById("insights-loading") as HTMLDivElement | null;
const insightsErrorEl = document.getElementById("insights-error") as HTMLDivElement | null;
const insightsOutputEl = document.getElementById("insights-output") as HTMLDivElement | null;

function openModal() {
  if (!analysisModal) return;
  analysisModal.classList.add("open");
  analysisModal.setAttribute("aria-hidden", "false");
}

function closeModal() {
  if (!analysisModal) return;
  analysisModal.classList.remove("open");
  analysisModal.setAttribute("aria-hidden", "true");
}

function getFullTranscript(): string {
  const lines = Array.from(formReceivedTextContainer.querySelectorAll("p"))
    .map((p) => (p.textContent || "").trim())
    .filter(Boolean);
  return lines.join("\n");
}

async function analyzeCurrentTranscript() {
  if (!insightsLoadingEl || !insightsErrorEl || !insightsOutputEl || !analyzeBtn) return;

  const transcriptRaw = getFullTranscript();
  if (!transcriptRaw) {
    insightsErrorEl.textContent = "No transcript to analyze.";
    insightsErrorEl.classList.remove("hidden");
    return;
  }

  // Optional truncate to avoid token overflow for very long sessions
  const maxChars = 12000;
  const transcript = transcriptRaw.length > maxChars
    ? transcriptRaw.slice(-maxChars)
    : transcriptRaw;

  insightsErrorEl.classList.add("hidden");
  insightsOutputEl.textContent = "";
  insightsLoadingEl.classList.remove("hidden");
  analyzeBtn.disabled = true;

  try {
    const endpoint = import.meta.env.VITE_CHAT_OPEN_AI_ENDPOINT || "";
    const key = import.meta.env.VITE_CHAT_OPEN_AI_KEY || "";
    const deploymentOrModel = import.meta.env.VITE_CHAT_OPEN_AI_DEPLOYMENT || "";

    if (!key) {
      throw new Error("Missing API key");
    }

    let url = "";
    let headers: Record<string, string> = { "Content-Type": "application/json" };
    let body: any;
    
    // Get the selected product for context
    const selectedProduct = getProductTopic();
    
    // Create product-specific analysis prompt
    let systemPrompt = "You are an expert sales coach analyzing a tennis racket sales conversation. ";
    
    if (selectedProduct && selectedProduct !== "General Customer (browsing)") {
      systemPrompt += `The customer was interested in the ${selectedProduct}. `;
      
      // Add product-specific coaching based on the racket
      if (selectedProduct.includes("Shift 99 V1")) {
        systemPrompt += "This racket is for players who want spin and control with modern technology. Focus on how well the salesperson explained spin benefits, eco-friendly features, and the innovative design. ";
      } else if (selectedProduct.includes("Blade 100 V9")) {
        systemPrompt += "This racket balances control with forgiveness, perfect for intermediate to advanced players. Focus on how well the salesperson addressed comfort, control vs. power balance, and the appealing design. ";
      } else if (selectedProduct.includes("Pro Staff 97 V14")) {
        systemPrompt += "This is a demanding control racket for serious players. Focus on how well the salesperson assessed the customer's skill level, explained the heritage, and addressed concerns about difficulty. ";
      }
    } else {
      systemPrompt += "This was a general consultation where the customer was browsing for rackets. Focus on how well the salesperson identified customer needs and guided them toward appropriate options. ";
    }
    
    systemPrompt += `
    
Please provide:
1. **Sales Performance Summary**: How effectively did the salesperson handle the customer's questions and concerns?
2. **Key Strengths**: What did the salesperson do well in terms of product knowledge, customer service, and sales technique?
3. **Areas for Improvement**: What could the salesperson have done better? Were there missed opportunities?
4. **Customer Engagement**: How engaged was the customer? Did they seem satisfied with the information provided?
5. **Action Items**: Specific recommendations for improving future sales conversations
6. **Product Knowledge Assessment**: How well did the salesperson demonstrate knowledge of the tennis racket features and benefits?

Focus on practical sales coaching advice to improve performance.`;

    if (endpoint) {
      // Azure OpenAI (Chat Completions)
      const base = endpoint.replace(/\/$/, "");
      const apiVersion = "2024-12-01-preview";
      url = `${base}/openai/deployments/${deploymentOrModel}/chat/completions?api-version=${apiVersion}`;
      headers["api-key"] = key;
      body = {
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: `Sales Conversation Transcript:\n\n${transcript}` }
        ],
        temperature: (() => {
          const envTemp = import.meta.env.VITE_GENERAL_TEMPERATURE;
          return envTemp !== undefined && !isNaN(parseFloat(envTemp)) ? parseFloat(envTemp) : 0.3;
        })(),
        max_completion_tokens: 1000
      };
    } else {
      // OpenAI (public)
      url = "https://api.openai.com/v1/chat/completions";
      headers["Authorization"] = `Bearer ${key}`;
      body = {
        model: deploymentOrModel || "gpt-4o-mini",
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: `Sales Conversation Transcript:\n\n${transcript}` }
        ],
        temperature: 0.3,
        max_completion_tokens: 1000
      };
    }

    const res = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Analysis request failed: ${res.status} ${res.statusText} - ${text}`);
    }

    const data = await res.json();
    console.log ("Sales analysis response:", data);
    const content: string = data?.choices?.[0]?.message?.content || "";
    insightsOutputEl.textContent = content || "No insights returned.";
  } catch (err: any) {
    insightsErrorEl.textContent = err?.message || String(err);
    insightsErrorEl.classList.remove("hidden");
  } finally {
    insightsLoadingEl.classList.add("hidden");
    analyzeBtn.disabled = false;
  }
}

// Populate product dropdown on load
void populateProductDropdown();

formStartButton.addEventListener("click", async () => {
  setFormInputState(InputState.Working);

  const endpoint = import.meta.env.VITE_REALTIME_OPEN_AI_ENDPOINT || "";
  const key = import.meta.env.VITE_REALTIME_OPEN_AI_KEY || "";
  const deploymentOrModel = import.meta.env.VITE_REALTIME_OPEN_AI_DEPLOYMENT || "";

  console.log("Starting with:", { endpoint, key, deploymentOrModel });
  if (!endpoint && !deploymentOrModel) {
    alert("Endpoint and Deployment are required for Azure OpenAI");
    return;
  }

  if (!deploymentOrModel) {
    alert("Model is required for OpenAI");
    return;
  }

  if (!key) {
    alert("API Key is required");
    return;
  }

  try {
    start_realtime(endpoint, key, deploymentOrModel);
  } catch (error) {
    console.log(error);
    setFormInputState(InputState.ReadyToStart);
  }
});
// stop initate here adding popup.
formStopButton.addEventListener("click", async () => {
  setFormInputState(InputState.Working);
  resetAudio(false);
  realtimeStreaming.close();
  setFormInputState(InputState.ReadyToStart);
  // Show modal with options after stopping
  openModal();
});

formClearAllButton.addEventListener("click", async () => {
  formReceivedTextContainer.innerHTML = "";
});

// Modal event wiring
closeModalBtn?.addEventListener("click", () => closeModal());
analysisModal?.addEventListener("click", (e) => {
  const target = e.target as HTMLElement;
  if (target?.dataset?.close === "true") {
    closeModal();
  }
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && analysisModal?.classList.contains("open")) {
    closeModal();
  }
});

modalClearDisplayBtn?.addEventListener("click", () => {
  formReceivedTextContainer.innerHTML = "";
  closeModal();
});

analyzeBtn?.addEventListener("click", () => {
  analyzeCurrentTranscript();
});

// Test visualizer with fake data
formTestVisualizerButton.addEventListener("click", () => {
  console.log("Testing visualizer with fake audio data");
  audioVisualizer.testWithFakeData();
});