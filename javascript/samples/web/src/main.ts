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
      },
      // Add output format specification for English
      output_audio_format: "pcm16"
    }
  };

  let temperature = 1;
  const envTemp = import.meta.env.VITE_GENERAL_TEMPERATURE;
  if (envTemp !== undefined && !isNaN(parseFloat(envTemp))) {
    temperature = parseFloat(envTemp);
  }
  const voice = getVoice();
  const product = getProductTopic();

  // Define comprehensive system instructions for the Hesitant Healthcare Administrator persona
  let baseInstructions = `YOU ARE A HEALTHCARE ADMINISTRATOR (the customer), NOT THE SALES REPRESENTATIVE. You are meeting with a sales representative who is trying to sell you Naloxone for your healthcare facility.

CRITICAL ROLE: You are "The Hesitant Healthcare Administrator" - budget-conscious, risk-averse, and concerned about public perception and operational overhead.

CRITICAL LANGUAGE REQUIREMENT: You MUST communicate EXCLUSIVELY in English. Under NO circumstances should you use any other language.

YOUR PERSONA CHARACTERISTICS:
- You are budget-conscious and question every expense
- You are risk-averse and worry about negative consequences
- You are concerned about public perception of your facility
- You worry about operational overhead and staff training burden
- You are skeptical but can be convinced with good arguments

CONVERSATION FLOW - Follow this specific script and ask these exact challenges:

1. OPENING STATEMENT (Start with this):
"Thanks for coming in. I understand you're here to talk about Naloxone. We've had some discussions internally, but I'm not sure it's the right fit for us."

2. CHALLENGE 1 - RELEVANCE (Ask this early in conversation):
"Why should we invest in Naloxone when opioid overdoses aren't a major issue in our facility?"

3. CHALLENGE 2 - COST (Bring this up when discussing the product):
"Your product is more expensive than the generic version. What makes it worth the premium?"

4. CHALLENGE 3 - TRAINING BURDEN (Express this concern):
"We'd need to train a lot of staff. That's time and money we don't have."

5. CHALLENGE 4 - PUBLIC PERCEPTION (Voice this worry):
"Won't stocking Naloxone send the wrong message to our community?"

6. CHALLENGE 5 - COMPLIANCE (Ask about legal issues):
"Are there any legal risks or compliance issues we should be aware of?"

ASSESSMENT QUESTIONS (Weave these into the conversation naturally):
- Why is Naloxone relevant even in low-incidence facilities?
- What differentiates your Naloxone product from cheaper alternatives?
- How do you address training concerns for non-medical staff?
- What's your response to concerns about public perception?
- How do you support compliance and legal readiness?

BEHAVIORAL GUIDELINES:
- Stay in character as a hesitant, skeptical healthcare administrator
- Ask tough questions about cost, training, and perception
- Express genuine concerns about budget and operational impact
- Be professional but challenging
- Can be convinced if given strong arguments
- Focus on practical business concerns, not just medical benefits

WHAT YOU SHOULD NOT DO:
- Do NOT give medical advice or act like a medical expert
- Do NOT provide information about Naloxone - ask for it instead
- Do NOT act enthusiastic initially - be skeptical
- Do NOT break character or discuss off-topic subjects

Your goal is to realistically challenge the sales representative to practice handling objections and concerns that a real healthcare administrator would have.`;

  if (product && product.toLowerCase().includes('naloxone')) {
    baseInstructions += `\n\nSPECIFIC FOCUS: Since we're discussing ${product}, make sure to ask all the scripted questions about Naloxone specifically. Challenge the sales representative on cost, training requirements, public perception, and compliance issues related to stocking Naloxone in your healthcare facility.`;
  } else if (product) {
    baseInstructions += `\n\nADAPTED FOCUS: While the script is designed for Naloxone, adapt the same challenging approach for ${product}. Ask about cost vs. generic alternatives, training requirements, public perception, and compliance issues related to ${product}.`;
  }

  configMessage.session.instructions = baseInstructions;
  configMessage.session.temperature = temperature;
  if (voice) {
    configMessage.session.voice = voice;
  }

  return configMessage;
}

async function sendInitialAIMessage() {
  try {
    const selectedProduct = getProductTopic();
    let initialMessage = "";

    if (selectedProduct && selectedProduct.toLowerCase().includes('naloxone')) {
      // Use the exact script opening for Naloxone
      initialMessage = "Thanks for coming in. I understand you're here to talk about Naloxone. We've had some discussions internally, but I'm not sure it's the right fit for us.";
    } else if (selectedProduct) {
      // Adapt the script opening for other products
      initialMessage = `Thanks for coming in. I understand you're here to talk about ${selectedProduct}. We've had some discussions internally, but I'm not sure it's the right fit for us.`;
    } else {
      // General healthcare administrator opening
      initialMessage = "Thanks for coming in. I understand you're here to discuss some pharmaceutical products for our facility. We've had some discussions internally, but I want to understand what you're proposing.";
    }

    // Send the initial message as an assistant message to make it look like AI is starting
    await realtimeStreaming.send({
      type: "conversation.item.create",
      item: {
        type: "message",
        role: "assistant",
        content: [
          {
            type: "text",
            text: initialMessage
          }
        ]
      }
    });

    // Trigger a response to make the AI actually speak the initial message
    await realtimeStreaming.send({
      type: "response.create"
    });

  } catch (error) {
    console.error("Failed to send initial AI message:", error);
  }
}
// Function to send a correction message to keep AI on track
async function sendCorrectionMessage() {
  try {
    await realtimeStreaming.send({
      type: "conversation.item.create",
      item: {
        type: "message",
        role: "system",
        content: [
          {
            type: "input_text",
            text: "REMEMBER: You are the HEALTHCARE ADMINISTRATOR (customer), not the sales representative. Follow the script - be skeptical and ask the challenging questions about cost, training, compliance, and public perception. Stay in character as a hesitant, budget-conscious administrator."
          }
        ]
      }
    });

    await realtimeStreaming.send({
      type: "response.create"
    });
  } catch (error) {
    console.error("Failed to send correction message:", error);
  }
}

// Function to validate that AI responses are in English and on topic
function validateResponse(text: string): boolean {
  // Check for common non-English phrases or characters
  const nonEnglishPatterns = [
    /[\u0590-\u05FF]/, // Hebrew
    /[\u0600-\u06FF]/, // Arabic
    /[\u4E00-\u9FFF]/, // Chinese
    /[\u3040-\u309F]/, // Hiragana
    /[\u30A0-\u30FF]/, // Katakana
    /[\u0400-\u04FF]/, // Cyrillic
    /שלום|مرحبا|你好|こんにちは|привет/i // Common greetings in other languages
  ];
  
  // Check for off-topic content
  const offTopicPatterns = [
    /weather|sports|politics|entertainment|movies|music/i,
    /cooking|recipes|travel|vacation|personal life/i,
    /technology|computers|software|games/i
  ];
  
  // Check for sales representative behavior (AI acting as expert instead of customer/administrator)
  const salesRepBehaviorPatterns = [
    /I'm happy to help|I'd be happy to help|I can help you|let me help you/i,
    /what symptoms are you experiencing|what are you looking for|how can I assist/i,
    /this medication works by|it works by|this is used for|it's effective for/i,
    /are you looking for something for|do you need something for/i,
    /my recommendation is|I recommend that you|I suggest that you/i
  ];
  
  // Allow healthcare administrator phrases (these are OK for the persona)
  const adminAllowedPhrases = [
    /thanks for coming in|we've had discussions|not sure it's the right fit/i,
    /why should we invest|what makes it worth|we'd need to train/i,
    /send the wrong message|legal risks|compliance issues/i
  ];
  
  // Check if text contains non-English content
  for (const pattern of nonEnglishPatterns) {
    if (pattern.test(text)) {
      console.warn("Non-English content detected:", text);
      return false;
    }
  }
  
  // Check if text is off-topic
  for (const pattern of offTopicPatterns) {
    if (pattern.test(text)) {
      console.warn("Off-topic content detected:", text);
      return false;
    }
  }
  
  // Check if AI is acting like sales rep instead of customer/administrator
  // But allow healthcare administrator phrases that are part of the script
  let isActingAsSalesRep = false;
  for (const pattern of salesRepBehaviorPatterns) {
    if (pattern.test(text)) {
      // Check if it's an allowed admin phrase
      let isAllowedAdminPhrase = false;
      for (const adminPattern of adminAllowedPhrases) {
        if (adminPattern.test(text)) {
          isAllowedAdminPhrase = true;
          break;
        }
      }
      if (!isAllowedAdminPhrase) {
        console.warn("AI acting as sales representative instead of customer/administrator:", text);
        isActingAsSalesRep = true;
        break;
      }
    }
  }
  
  if (isActingAsSalesRep) {
    return false;
  }
  
  return true;
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
          makeNewTextBlock("<< Session Started - Customer interested in Padagis Products >>");
        }
        makeNewTextBlock();
        // Send initial AI message to start the conversation
        await sendInitialAIMessage();
        break;
      case "response.audio_transcript.delta":
        // Validate the response for English-only and on-topic content
        if (validateResponse(message.delta)) {
          appendToTextBlock(message.delta);
        } else {
          // Log validation failure and send a correction prompt
          console.warn("Response validation failed for:", message.delta);
          appendToTextBlock(message.delta); // Still show it but log the issue
          // Send correction message to guide AI back on track
          await sendCorrectionMessage();
        }
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
  // Remove placeholder if it exists
  const placeholder = formReceivedTextContainer.querySelector('.conversation-placeholder');
  if (placeholder) {
    placeholder.remove();
  }
  
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
const exportAnalysisBtn = document.getElementById("export-analysis") as HTMLButtonElement | null;
const analyzeBtn = document.getElementById("analyze-transcript") as HTMLButtonElement | null;
const modalClearDisplayBtn = document.getElementById("clear-display") as HTMLButtonElement | null;
const insightsLoadingEl = document.getElementById("insights-loading") as HTMLDivElement | null;
const insightsErrorEl = document.getElementById("insights-error") as HTMLDivElement | null;
const insightsOutputEl = document.getElementById("insights-output") as HTMLDivElement | null;
const analysisStatusEl = document.getElementById("analysis-status") as HTMLSpanElement | null;
const errorMessageEl = document.getElementById("error-message") as HTMLParagraphElement | null;

let lastAnalysisResult: string = "";
let isAnalysisLoaded = false;

function openModal() {
  if (!analysisModal) return;
  analysisModal.classList.add("open");
  analysisModal.setAttribute("aria-hidden", "false");
  
  // Update status and export button state
  updateAnalysisStatus();
}

function closeModal() {
  if (!analysisModal) return;
  analysisModal.classList.remove("open");
  analysisModal.setAttribute("aria-hidden", "true");
}

function updateAnalysisStatus() {
  if (!analysisStatusEl) return;
  
  if (isAnalysisLoaded) {
    analysisStatusEl.textContent = "Analysis Complete";
    analysisStatusEl.style.background = "#d1fae5";
    analysisStatusEl.style.color = "#065f46";
  } else {
    analysisStatusEl.textContent = "No Analysis";
    analysisStatusEl.style.background = "var(--light-teal)";
    analysisStatusEl.style.color = "var(--primary-teal)";
  }
}

function exportAnalysisToFile() {
  if (!lastAnalysisResult) {
    alert("No analysis available to export. Please run an analysis first.");
    return;
  }

  const timestamp = new Date().toISOString().slice(0, 19).replace(/:/g, '-');
  const selectedProduct = getProductTopic() || "General";
  const filename = `Sales_Analysis_${selectedProduct}_${timestamp}.txt`;
  
  const transcript = getFullTranscript();
  const exportContent = `PHARMACEUTICAL SALES PERFORMANCE ANALYSIS
Generated: ${new Date().toLocaleString()}
Product Focus: ${selectedProduct}
==================================================

CONVERSATION TRANSCRIPT:
${transcript}

==================================================

ANALYSIS RESULTS:
${lastAnalysisResult}

==================================================
Export generated by Padagis OTC Sales Training Simulator
`;

  const blob = new Blob([exportContent], { type: 'text/plain' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

function createCollapsibleSection(title: string, content: string): string {
  const sectionId = title.toLowerCase().replace(/[^a-z0-9]/g, '-');
  return `
    <div class="analysis-section">
      <button class="section-toggle expanded" data-section="${sectionId}">
        <span>${title}</span>
        <span class="toggle-icon">▲</span>
      </button>
      <div class="section-content expanded" data-content="${sectionId}">
        <p>${content.replace(/\n/g, '<br>')}</p>
      </div>
    </div>
  `;
}

function formatAnalysisWithSections(analysisText: string): string {
  // Parse the analysis text into sections
  const sections = [];
  const lines = analysisText.split('\n');
  let currentSection = { title: '', content: '' };
  
  // Define section mappings without icons
  const sectionMappings = [
    { keywords: ['sales performance', 'summary'], title: 'Sales Performance Summary' },
    { keywords: ['key strengths', 'strengths'], title: 'Key Strengths' },
    { keywords: ['areas for improvement', 'improvement', 'weaknesses'], title: 'Areas for Improvement' },
    { keywords: ['customer engagement'], title: 'Customer Engagement' },
    { keywords: ['action items', 'recommendations'], title: 'Action Items' },
    { keywords: ['product knowledge'], title: 'Product Knowledge Assessment' }
  ];

  for (const line of lines) {
    const trimmedLine = line.trim();
    if (!trimmedLine) continue;

    // Check if this line starts a new section
    const isHeader = /^\d+\.\s|\*\*/.test(trimmedLine) || trimmedLine.endsWith(':');
    
    if (isHeader) {
      // Save previous section if it has content
      if (currentSection.title && currentSection.content) {
        sections.push({ ...currentSection });
      }
      
      // Find matching section mapping
      const mapping = sectionMappings.find(m => 
        m.keywords.some(keyword => trimmedLine.toLowerCase().includes(keyword))
      );
      
      currentSection = {
        title: mapping ? mapping.title : trimmedLine.replace(/^\d+\.\s|\*\*/g, '').replace(/:/g, ''),
        content: ''
      };
    } else {
      currentSection.content += (currentSection.content ? '\n' : '') + trimmedLine;
    }
  }
  
  // Add the last section
  if (currentSection.title && currentSection.content) {
    sections.push(currentSection);
  }
  
  // If no clear sections were found, create a single section
  if (sections.length === 0) {
    sections.push({
      title: 'Analysis Results',
      content: analysisText
    });
  }

  return sections.map(section => 
    createCollapsibleSection(section.title, section.content)
  ).join('');
}

function setupCollapsibleSections() {
  const toggleButtons = document.querySelectorAll('.section-toggle');
  toggleButtons.forEach(button => {
    button.addEventListener('click', () => {
      const sectionId = button.getAttribute('data-section');
      const content = document.querySelector(`[data-content="${sectionId}"]`) as HTMLElement;
      const icon = button.querySelector('.toggle-icon') as HTMLElement;
      
      if (content) {
        const isExpanded = content.classList.contains('expanded');
        
        if (isExpanded) {
          content.classList.remove('expanded');
          button.classList.remove('expanded');
          if (icon) icon.textContent = '▼';
        } else {
          content.classList.add('expanded');
          button.classList.add('expanded');
          if (icon) icon.textContent = '▲';
        }
      }
    });
  });
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
    if (errorMessageEl) {
      errorMessageEl.textContent = "No transcript to analyze. Please have a conversation first.";
    }
    insightsErrorEl.classList.remove("hidden");
    return;
  }

  // Clear previous results and show loading
  insightsErrorEl.classList.add("hidden");
  insightsOutputEl.innerHTML = "";
  insightsLoadingEl.classList.remove("hidden");
  analyzeBtn.disabled = true;
  isAnalysisLoaded = false;
  updateAnalysisStatus();

  // Optional truncate to avoid token overflow for very long sessions
  const maxChars = 12000;
  const transcript = transcriptRaw.length > maxChars
    ? transcriptRaw.slice(-maxChars)
    : transcriptRaw;

  try {
    const endpoint = import.meta.env.VITE_CHAT_OPEN_AI_ENDPOINT || "";
    const key = import.meta.env.VITE_CHAT_OPEN_AI_KEY || "";
    const deploymentOrModel = import.meta.env.VITE_CHAT_OPEN_AI_DEPLOYMENT || "";

    if (!key) {
      throw new Error("Missing API key for analysis");
    }

    let url = "";
    let headers: Record<string, string> = { "Content-Type": "application/json" };
    let body: any;
    
    // Get the selected product for context
    const selectedProduct = getProductTopic();
    
    // Create analysis prompt focused on pharmaceutical sales coaching
    let systemPrompt = "You are an expert pharmaceutical sales coach analyzing a sales consultation. ";
    
    if (selectedProduct && selectedProduct !== "General Customer (browsing)") {
      systemPrompt += `The customer was interested in ${selectedProduct}. `;
    }
    
    systemPrompt += "Focus on how well the sales representative handled the customer's questions, addressed concerns, demonstrated product knowledge, and managed objections during this pharmaceutical sales interaction. ";
    
    systemPrompt += `
    
Please provide:
1. **Sales Performance Summary**: How effectively did the sales representative handle the customer's health-related questions and concerns?
2. **Key Strengths**: What did the sales representative do well in terms of product knowledge, customer safety guidance, and professional consultation technique?
3. **Areas for Improvement**: What could the sales representative have done better? Were there missed opportunities to address safety or efficacy concerns?
4. **Customer Engagement**: How engaged was the customer? Did they seem satisfied with the medication information and safety guidance provided?
5. **Action Items**: Specific recommendations for improving future pharmaceutical consultations
6. **Product Knowledge Assessment**: How well did the sales representative demonstrate knowledge of the OTC medication's benefits, proper usage, and safety considerations?

Focus on practical pharmaceutical sales coaching advice to improve performance while ensuring customer safety and regulatory compliance.`;

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
        max_completion_tokens: 40000
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
        max_completion_tokens: 40000
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
    const content: string = data?.choices?.[0]?.message?.content || "";
    
    if (!content || content.trim().length === 0) {
      // Check if there's an error in the response
      if (data?.error) {
        if (errorMessageEl) {
          errorMessageEl.textContent = `API Error: ${JSON.stringify(data.error)}`;
        }
      } else {
        if (errorMessageEl) {
          errorMessageEl.textContent = "No insights returned from API. Please try again.";
        }
      }
      insightsErrorEl.classList.remove("hidden");
    } else {
      // Store the analysis result and format it with collapsible sections
      lastAnalysisResult = content;
      isAnalysisLoaded = true;
      
      // Create the analysis content with collapsible sections
      const formattedContent = formatAnalysisWithSections(content);
      insightsOutputEl.innerHTML = `<div class="analysis-content">${formattedContent}</div>`;
      
      // Add event listeners for collapsible sections
      setupCollapsibleSections();
      updateAnalysisStatus();
    }
    
  } catch (err: any) {
    console.error("Analysis error:", err);
    if (errorMessageEl) {
      errorMessageEl.textContent = err?.message || String(err);
    }
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

// Helper function to restore conversation placeholder
function restoreConversationPlaceholder() {
  formReceivedTextContainer.innerHTML = `
    <div class="conversation-placeholder">
      <div class="placeholder-icon">💬</div>
      <h3>Sales Conversation</h3>
      <p>Your conversation with the AI customer will appear here. Start recording to begin the sales simulation.</p>
    </div>
  `;
  
  // Reset analysis state
  lastAnalysisResult = "";
  isAnalysisLoaded = false;
  if (insightsOutputEl) {
    insightsOutputEl.innerHTML = `
      <div class="no-analysis-placeholder">
        <div class="placeholder-icon">�</div>
        <h4>Ready for Analysis</h4>
        <p>Click "Analyze Sales Performance" to get detailed coaching insights on your pharmaceutical sales conversation.</p>
      </div>
    `;
  }
  updateAnalysisStatus();
}

formClearAllButton.addEventListener("click", async () => {
  restoreConversationPlaceholder();
});

// Modal event wiring
closeModalBtn?.addEventListener("click", () => closeModal());
exportAnalysisBtn?.addEventListener("click", () => exportAnalysisToFile());
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
  restoreConversationPlaceholder();
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