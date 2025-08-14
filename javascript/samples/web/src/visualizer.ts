// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

export class CircularAudioVisualizer {
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private audioContext: AudioContext | null = null;
  private analyser: AnalyserNode | null = null;
  private dataArray: Uint8Array | null = null;
  private animationId: number | null = null;
  private isInitialized = false;

  // Visualization parameters
  private centerX = 0;
  private centerY = 0;
  private baseRadius = 80;
  private maxRadius = 150;
  private segments = 64;

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d')!;
    this.setupCanvas();
    this.setupResizeListener();
  }

  private setupCanvas() {
    const container = this.canvas.parentElement!;
    const updateCanvasSize = () => {
      const rect = container.getBoundingClientRect();
      const size = Math.min(rect.width, rect.height) * 0.8;
      
      this.canvas.width = size;
      this.canvas.height = size;
      this.canvas.style.width = `${size}px`;
      this.canvas.style.height = `${size}px`;
      
      this.centerX = size / 2;
      this.centerY = size / 2;
      this.baseRadius = size * 0.15;
      this.maxRadius = size * 0.35;
    };
    
    updateCanvasSize();
  }

  private setupResizeListener() {
    window.addEventListener('resize', () => {
      this.setupCanvas();
    });
  }

  public async initializeWithStream(stream: MediaStream) {
    if (this.isInitialized) {
      this.cleanup();
    }

    try {
      console.log('Initializing visualizer with stream:', stream);
      this.audioContext = new AudioContext();
      
      // Resume audio context if it's suspended (required in modern browsers)
      if (this.audioContext.state === 'suspended') {
        await this.audioContext.resume();
        console.log('Audio context resumed');
      }
      
      const source = this.audioContext.createMediaStreamSource(stream);
      this.analyser = this.audioContext.createAnalyser();
      
      this.analyser.fftSize = 256;
      this.analyser.smoothingTimeConstant = 0.8;
      
      source.connect(this.analyser);
      
      const bufferLength = this.analyser.frequencyBinCount;
      this.dataArray = new Uint8Array(new ArrayBuffer(bufferLength));
      
      this.isInitialized = true;
      console.log('Visualizer initialized successfully, buffer length:', bufferLength);
      this.startAnimation();
    } catch (error) {
      console.error('Failed to initialize audio visualizer:', error);
    }
  }

  public initializeWithAudioContext(audioContext: AudioContext, sourceNode: AudioNode) {
    if (this.isInitialized) {
      this.cleanup();
    }

    try {
      this.audioContext = audioContext;
      this.analyser = audioContext.createAnalyser();
      
      this.analyser.fftSize = 256;
      this.analyser.smoothingTimeConstant = 0.8;
      
      sourceNode.connect(this.analyser);
      
      const bufferLength = this.analyser.frequencyBinCount;
      this.dataArray = new Uint8Array(new ArrayBuffer(bufferLength));
      
      this.isInitialized = true;
      this.startAnimation();
    } catch (error) {
      console.error('Failed to initialize audio visualizer:', error);
    }
  }

  private startAnimation() {
    if (!this.isInitialized || !this.analyser || !this.dataArray) return;

    const animate = () => {
      if (!this.isInitialized) return;
      
      this.analyser!.getByteFrequencyData(this.dataArray!);
      this.draw();
      this.animationId = requestAnimationFrame(animate);
    };

    animate();
  }

  private draw() {
    if (!this.dataArray) return;

    // Clear canvas with fade effect
    this.ctx.fillStyle = 'rgba(26, 26, 46, 0.1)';
    this.ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);

    const segmentAngle = (Math.PI * 2) / this.segments;
    const dataStep = Math.floor(this.dataArray.length / this.segments);

    // Calculate average amplitude for overall effects
    const avgAmplitude = this.dataArray.reduce((sum, val) => sum + val, 0) / this.dataArray.length;
    const normalizedAvg = avgAmplitude / 255;

    // Debug logging (remove later)
    if (Math.random() < 0.01) { // Log occasionally
      console.log('Audio data - Average amplitude:', avgAmplitude, 'Max value:', Math.max(...this.dataArray));
    }

    // Dynamic base radius based on overall amplitude
    const dynamicBaseRadius = this.baseRadius + (normalizedAvg * 20);

    for (let i = 0; i < this.segments; i++) {
      const dataIndex = Math.min(i * dataStep, this.dataArray.length - 1);
      const amplitude = this.dataArray[dataIndex];
      const normalizedAmplitude = amplitude / 255;

      const angle = i * segmentAngle - Math.PI / 2; // Start from top
      
      // Calculate dynamic radius
      const radiusVariation = normalizedAmplitude * (this.maxRadius - dynamicBaseRadius);
      const radius = dynamicBaseRadius + radiusVariation;

      // Calculate positions
      const x1 = this.centerX + Math.cos(angle) * dynamicBaseRadius;
      const y1 = this.centerY + Math.sin(angle) * dynamicBaseRadius;
      const x2 = this.centerX + Math.cos(angle) * radius;
      const y2 = this.centerY + Math.sin(angle) * radius;

      // Color based on frequency and amplitude
      const hue = (i / this.segments) * 360 + (normalizedAmplitude * 60);
      const saturation = 70 + (normalizedAmplitude * 30);
      const lightness = 50 + (normalizedAmplitude * 30);
      
      // Dynamic line width
      const lineWidth = 2 + (normalizedAmplitude * 4);

      this.ctx.strokeStyle = `hsl(${hue}, ${saturation}%, ${lightness}%)`;
      this.ctx.lineWidth = lineWidth;
      this.ctx.lineCap = 'round';

      // Draw line from center to edge
      this.ctx.beginPath();
      this.ctx.moveTo(x1, y1);
      this.ctx.lineTo(x2, y2);
      this.ctx.stroke();

      // Add glow effect for high amplitudes
      if (normalizedAmplitude > 0.6) {
        this.ctx.shadowColor = `hsl(${hue}, ${saturation}%, ${lightness}%)`;
        this.ctx.shadowBlur = 10;
        this.ctx.stroke();
        this.ctx.shadowBlur = 0;
      }
    }

    // Draw center circle with pulsing effect
    const centerRadius = 8 + (normalizedAvg * 12);
    const centerHue = (Date.now() * 0.1) % 360;
    
    this.ctx.fillStyle = `hsl(${centerHue}, 70%, ${50 + normalizedAvg * 30}%)`;
    this.ctx.beginPath();
    this.ctx.arc(this.centerX, this.centerY, centerRadius, 0, Math.PI * 2);
    this.ctx.fill();

    // Outer ring for overall amplitude
    if (normalizedAvg > 0.1) {
      const outerRingRadius = dynamicBaseRadius - 5;
      this.ctx.strokeStyle = `hsla(${centerHue}, 60%, 60%, ${normalizedAvg})`;
      this.ctx.lineWidth = 2;
      this.ctx.beginPath();
      this.ctx.arc(this.centerX, this.centerY, outerRingRadius, 0, Math.PI * 2);
      this.ctx.stroke();
    }
  }

  public stop() {
    this.isInitialized = false;
    if (this.animationId) {
      cancelAnimationFrame(this.animationId);
      this.animationId = null;
    }
    this.cleanup();
  }

  private cleanup() {
    // Clear canvas
    this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    
    // Reset visualization state
    this.dataArray = null;
    this.analyser = null;
    
    // Note: We don't close the audioContext here as it might be shared
    // The calling code should handle AudioContext lifecycle
  }

  public drawIdleState() {
    // Draw a static visualization when no audio is playing
    this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    
    const time = Date.now() * 0.001;
    const segmentAngle = (Math.PI * 2) / this.segments;

    for (let i = 0; i < this.segments; i++) {
      const angle = i * segmentAngle - Math.PI / 2;
      const phase = i * 0.1 + time;
      const amplitude = (Math.sin(phase) + 1) * 0.5 * 0.3; // Gentle wave

      const radius = this.baseRadius + (amplitude * 30);
      
      const x1 = this.centerX + Math.cos(angle) * (this.baseRadius - 10);
      const y1 = this.centerY + Math.sin(angle) * (this.baseRadius - 10);
      const x2 = this.centerX + Math.cos(angle) * radius;
      const y2 = this.centerY + Math.sin(angle) * radius;

      const hue = (i / this.segments) * 360;
      this.ctx.strokeStyle = `hsla(${hue}, 50%, 40%, 0.6)`;
      this.ctx.lineWidth = 1.5;
      this.ctx.lineCap = 'round';

      this.ctx.beginPath();
      this.ctx.moveTo(x1, y1);
      this.ctx.lineTo(x2, y2);
      this.ctx.stroke();
    }

    // Center dot
    this.ctx.fillStyle = 'hsla(220, 50%, 50%, 0.8)';
    this.ctx.beginPath();
    this.ctx.arc(this.centerX, this.centerY, 6, 0, Math.PI * 2);
    this.ctx.fill();
  }

  public testWithFakeData() {
    console.log('Starting fake data test');
    this.stop(); // Stop any existing animation
    
    // Create fake frequency data
    this.dataArray = new Uint8Array(new ArrayBuffer(128));
    this.isInitialized = true;
    
    const startTime = Date.now();
    const animate = () => {
      const elapsed = (Date.now() - startTime) / 1000;
      
      // Generate fake audio data with some variation
      for (let i = 0; i < this.dataArray!.length; i++) {
        const frequency = i / this.dataArray!.length;
        const time = elapsed * 2;
        const base = Math.sin(time + frequency * Math.PI * 4) * 0.5 + 0.5;
        const variation = Math.sin(time * 3 + i * 0.1) * 0.3;
        this.dataArray![i] = Math.floor((base + variation) * 255);
      }
      
      this.draw();
      
      // Run for 5 seconds
      if (elapsed < 5) {
        requestAnimationFrame(animate);
      } else {
        console.log('Fake data test complete');
        this.stop();
      }
    };
    
    animate();
  }
}
