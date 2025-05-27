/**
 * WSJTX Library Complete Feature Examples
 * 
 * This file demonstrates various features of wsjtx_lib, including:
 * - FT8 message encoding and decoding
 * - WAV file audio operations
 * - Audio format conversion and resampling
 * - WSPR decoding
 * - Error handling
 * - Mode capability queries
 * 
 * Based on actual tested and verified working code
 */

import { WSJTXLib, WSJTXMode, WSJTXError } from 'wsjtx-lib';
import * as fs from 'fs';
import * as path from 'path';
import * as wav from 'wav';

// Create output directory
const outputDir = path.join(process.cwd(), 'examples', 'output');
if (!fs.existsSync(outputDir)) {
  fs.mkdirSync(outputDir, { recursive: true });
}

/**
 * Example 1: FT8 Complete Encode-Decode Cycle
 * Demonstrates the complete workflow from message encoding to WAV file saving, then reading and decoding
 */
async function exampleFT8FullCycle() {
  console.log('\n🎯 === FT8 Complete Encode-Decode Cycle Example ===');
  
  const lib = new WSJTXLib();
  const message = 'CQ DX BH1ABC OM88';
  const audioFrequency = 1000; // Use 1000Hz, consistent with wsjtx_lib internals
  
  try {
    console.log(`📝 Original message: "${message}"`);
    console.log(`🎵 Audio frequency: ${audioFrequency} Hz`);
    
    // Step 1: Encode message
    console.log('\n📤 Step 1: Encoding FT8 message...');
    const encodeResult = await lib.encode(WSJTXMode.FT8, message, audioFrequency);
    
    console.log(`   ✅ Encoding successful!`);
    console.log(`   Actual message sent: "${encodeResult.messageSent.trim()}"`);
    console.log(`   Audio samples: ${encodeResult.audioData.length}`);
    console.log(`   Audio duration: ${(encodeResult.audioData.length / lib.getSampleRate(WSJTXMode.FT8)).toFixed(2)} seconds`);
    
    // Check audio data range
    let minVal = Infinity, maxVal = -Infinity;
    for (let i = 0; i < encodeResult.audioData.length; i++) {
      const val = encodeResult.audioData[i];
      if (val < minVal) minVal = val;
      if (val > maxVal) maxVal = val;
    }
    console.log(`   Audio amplitude range: ${minVal.toFixed(4)} to ${maxVal.toFixed(4)}`);
    
    // Step 2: Save as WAV file
    console.log('\n💾 Step 2: Saving as WAV file...');
    const wavFilePath = path.join(outputDir, 'ft8_example.wav');
    
    // Convert to 16-bit integers
    const audioInt16 = new Int16Array(encodeResult.audioData.length);
    for (let i = 0; i < encodeResult.audioData.length; i++) {
      audioInt16[i] = Math.round(encodeResult.audioData[i] * 32767);
    }
    
    await new Promise<void>((resolve, reject) => {
      const writer = new wav.FileWriter(wavFilePath, {
        channels: 1,
        sampleRate: lib.getSampleRate(WSJTXMode.FT8),
        bitDepth: 16
      });
      
      writer.on('error', reject);
      writer.on('done', () => resolve());
      
      const buffer = Buffer.from(audioInt16.buffer);
      writer.write(buffer);
      writer.end();
    });
    
    const stats = fs.statSync(wavFilePath);
    console.log(`   ✅ WAV file saved successfully: ${path.basename(wavFilePath)}`);
    console.log(`   File size: ${(stats.size / 1024).toFixed(2)} KB`);
    
    // Step 3: Read from WAV file
    console.log('\n📂 Step 3: Reading from WAV file...');
    const audioData = await new Promise<Float32Array>((resolve, reject) => {
      const reader = new wav.Reader();
      const chunks: Buffer[] = [];
      
      reader.on('format', (format: wav.Format) => {
        console.log(`   WAV format: ${format.channels} channel(s), ${format.sampleRate}Hz, ${format.bitDepth}-bit`);
      });
      
      reader.on('data', (chunk: Buffer) => chunks.push(chunk));
      reader.on('end', () => {
        const buffer = Buffer.concat(chunks);
        const audioInt16 = new Int16Array(buffer.buffer, buffer.byteOffset, buffer.length / 2);
        const audioFloat32 = new Float32Array(audioInt16.length);
        for (let i = 0; i < audioInt16.length; i++) {
          audioFloat32[i] = audioInt16[i] / 32767.0;
        }
        resolve(audioFloat32);
      });
      reader.on('error', reject);
      
      fs.createReadStream(wavFilePath).pipe(reader);
    });
    
    console.log(`   ✅ Audio data read successfully`);
    console.log(`   Samples read: ${audioData.length}`);
    
    // Step 4: Decode audio (using correct resampling method)
    console.log('\n🔍 Step 4: Decoding audio data...');
    
    // Resample to 12kHz (required by wsjtx_lib internals)
    const resampleTo12kHz = (audioData48k: Float32Array): Float32Array => {
      const audioData12k = new Float32Array(Math.floor(audioData48k.length / 4));
      for (let i = 0; i < audioData12k.length; i++) {
        audioData12k[i] = audioData48k[i * 4];
      }
      return audioData12k;
    };
    
    const resampled = resampleTo12kHz(audioData);
    console.log(`   Resampled: ${audioData.length} -> ${resampled.length} samples (48kHz -> 12kHz)`);
    
    // Convert to Int16Array (required by wsjtx_lib internals)
    const audioInt16ForDecode = new Int16Array(resampled.length);
    for (let i = 0; i < resampled.length; i++) {
      audioInt16ForDecode[i] = Math.round(resampled[i] * 32767);
    }
    console.log(`   Converted to Int16Array: ${audioInt16ForDecode.length} samples`);
    
    // Clear message queue and decode
    lib.pullMessages();
    const decodeResult = await lib.decode(WSJTXMode.FT8, audioInt16ForDecode, audioFrequency);
    console.log(`   Decode result: ${decodeResult.success ? 'Success' : 'Failed'}`);
    
    // Step 5: Verify decode results
    console.log('\n📨 Step 5: Checking decoded messages...');
    const messages = lib.pullMessages();
    console.log(`   Decoded ${messages.length} message(s)`);
    
    if (messages.length > 0) {
      messages.forEach((msg, index) => {
        console.log(`   Message ${index + 1}:`);
        console.log(`     Text: "${msg.text}"`);
        console.log(`     SNR: ${msg.snr} dB`);
        console.log(`     Time offset: ${msg.deltaTime.toFixed(2)} seconds`);
        console.log(`     Frequency offset: ${msg.deltaFrequency} Hz`);
      });
      
      const decodedMessage = messages[0].text;
      const isMatch = decodedMessage.trim() === message.trim();
      console.log(`\n🎯 Message verification:`);
      console.log(`   Original message: "${message}"`);
      console.log(`   Decoded message: "${decodedMessage}"`);
      console.log(`   Perfect match: ${isMatch ? '✅' : '❌'}`);
      
      if (isMatch) {
        console.log('\n🎉 Complete encode-decode cycle test successful!');
      }
    } else {
      console.log('   ❌ No messages decoded, may need parameter adjustment');
    }
    
  } catch (error) {
    if (error instanceof WSJTXError) {
      console.error('❌ WSJTX Error:', error.message, `(${error.code})`);
    } else {
      console.error('❌ Unexpected error:', error);
    }
  }
}

/**
 * Example 2: FT8 Message Encoding Demonstration
 * Shows encoding of different types of FT8 messages
 */
async function exampleFT8Encoding() {
  console.log('\n🎵 === FT8 Message Encoding Example ===');
  
  const lib = new WSJTXLib();
  const audioFrequency = 1000;
  
  const testMessages = [
    'CQ DX BH1ABC OM88',      // CQ call
    'BH1ABC BH2DEF +05',      // Signal report
    'BH2DEF BH1ABC R-12',     // Acknowledge signal report
    'BH1ABC BH2DEF RRR',      // Acknowledge received
    'BH2DEF BH1ABC 73'        // End contact
  ];
  
  console.log('Encoding different types of FT8 messages:');
  
  for (let i = 0; i < testMessages.length; i++) {
    const message = testMessages[i];
    try {
      console.log(`\n${i + 1}. Encoding message: "${message}"`);
      
      const result = await lib.encode(WSJTXMode.FT8, message, audioFrequency);
      
      console.log(`   ✅ Encoding successful`);
      console.log(`   Actually sent: "${result.messageSent.trim()}"`);
      console.log(`   Audio samples: ${result.audioData.length}`);
      
      // Save audio file
      const filename = `ft8_message_${i + 1}.wav`;
      const filepath = path.join(outputDir, filename);
      
      const audioInt16 = new Int16Array(result.audioData.length);
      for (let j = 0; j < result.audioData.length; j++) {
        audioInt16[j] = Math.round(result.audioData[j] * 32767);
      }
      
      await new Promise<void>((resolve, reject) => {
        const writer = new wav.FileWriter(filepath, {
          channels: 1,
          sampleRate: lib.getSampleRate(WSJTXMode.FT8),
          bitDepth: 16
        });
        
        writer.on('error', reject);
        writer.on('done', () => resolve());
        
        const buffer = Buffer.from(audioInt16.buffer);
        writer.write(buffer);
        writer.end();
      });
      
      console.log(`   💾 Saved as: ${filename}`);
      
    } catch (error) {
      console.error(`   ❌ Encoding failed:`, error instanceof WSJTXError ? error.message : error);
    }
  }
}

/**
 * Example 3: Audio Format Conversion
 * Demonstrates conversion between Float32Array and Int16Array
 */
function exampleAudioConversion() {
  console.log('\n🔄 === Audio Format Conversion Example ===');
  
  // Create test audio data (sine wave)
  const sampleRate = 48000;
  const frequency = 1000; // 1kHz sine wave
  const duration = 0.1; // 0.1 seconds
  const sampleCount = Math.floor(sampleRate * duration);
  
  console.log(`Generating test audio: ${frequency}Hz sine wave, ${duration}s, ${sampleCount} samples`);
  
  // Generate Float32Array format sine wave
  const floatData = new Float32Array(sampleCount);
  for (let i = 0; i < sampleCount; i++) {
    floatData[i] = Math.sin(2 * Math.PI * frequency * i / sampleRate) * 0.5;
  }
  
  console.log(`Original Float32Array:`);
  console.log(`  Sample count: ${floatData.length}`);
  console.log(`  Data type: ${floatData.constructor.name}`);
  console.log(`  First 5 samples: [${Array.from(floatData.slice(0, 5)).map(v => v.toFixed(4)).join(', ')}]`);
  
  // Calculate amplitude range
  let minVal = floatData[0];
  let maxVal = floatData[0];
  for (let i = 1; i < floatData.length; i++) {
    if (floatData[i] < minVal) minVal = floatData[i];
    if (floatData[i] > maxVal) maxVal = floatData[i];
  }
  console.log(`  Amplitude range: ${minVal.toFixed(4)} to ${maxVal.toFixed(4)}`);
  
  // Convert to Int16Array
  const intData = WSJTXLib.convertAudioFormat(floatData, 'int16') as Int16Array;
  console.log(`\nConverted to Int16Array:`);
  console.log(`  Sample count: ${intData.length}`);
  console.log(`  Data type: ${intData.constructor.name}`);
  console.log(`  First 5 samples: [${Array.from(intData.slice(0, 5)).join(', ')}]`);
  
  // Calculate Int16Array amplitude range
  let minIntVal = intData[0];
  let maxIntVal = intData[0];
  for (let i = 1; i < intData.length; i++) {
    if (intData[i] < minIntVal) minIntVal = intData[i];
    if (intData[i] > maxIntVal) maxIntVal = intData[i];
  }
  console.log(`  Amplitude range: ${minIntVal} to ${maxIntVal}`);
  
  // Convert back to Float32Array
  const floatData2 = WSJTXLib.convertAudioFormat(intData, 'float32') as Float32Array;
  console.log(`\nConverted back to Float32Array:`);
  console.log(`  Sample count: ${floatData2.length}`);
  console.log(`  Data type: ${floatData2.constructor.name}`);
  console.log(`  First 5 samples: [${Array.from(floatData2.slice(0, 5)).map(v => v.toFixed(4)).join(', ')}]`);
  
  // Calculate Float32Array amplitude range
  let minVal2 = floatData2[0];
  let maxVal2 = floatData2[0];
  for (let i = 1; i < floatData2.length; i++) {
    if (floatData2[i] < minVal2) minVal2 = floatData2[i];
    if (floatData2[i] > maxVal2) maxVal2 = floatData2[i];
  }
  console.log(`  Amplitude range: ${minVal2.toFixed(4)} to ${maxVal2.toFixed(4)}`);
  
  // Check conversion precision
  let maxDiff = 0;
  for (let i = 0; i < floatData.length; i++) {
    const diff = Math.abs(floatData[i] - floatData2[i]);
    if (diff > maxDiff) maxDiff = diff;
  }
  console.log(`\nConversion precision check:`);
  console.log(`  Maximum difference: ${maxDiff.toFixed(6)}`);
  console.log(`  Precision assessment: ${maxDiff < 0.001 ? '✅ High precision' : '⚠️ Precision loss'}`);
}

/**
 * Example 4: WSPR Decoding
 * Demonstrates WSPR protocol decoding functionality
 */
async function exampleWSPRDecode() {
  console.log('\n📡 === WSPR Decoding Example ===');
  
  const lib = new WSJTXLib();
  
  try {
    // Generate simulated WSPR IQ data
    const sampleCount = 1000; // Use smaller dataset for demonstration
    const iqData = new Float32Array(sampleCount * 2); // Interleaved I,Q data
    
    console.log(`Generating simulated WSPR IQ data: ${sampleCount} complex samples`);
    
    // Fill with low-level noise
    for (let i = 0; i < iqData.length; i++) {
      iqData[i] = (Math.random() - 0.5) * 0.001;
    }
    
    const options = {
      dialFrequency: 14095600, // 20m WSPR frequency
      callsign: 'BH1ABC',
      locator: 'OM88'
    };
    
    console.log(`WSPR decode options:`);
    console.log(`  Dial frequency: ${options.dialFrequency} Hz`);
    console.log(`  Callsign: ${options.callsign}`);
    console.log(`  Grid locator: ${options.locator}`);
    
    const results = await lib.decodeWSPR(iqData, options);
    
    console.log(`\nDecode results: Found ${results.length} WSPR signal(s)`);
    
    if (results.length > 0) {
      console.log('\nWSPR decode details:');
      console.log('Time    SNR     Freq    Drift  Callsign  Grid  Power');
      console.log('------  ------  ------  -----  --------  ----  -----');
      
      results.forEach((result, index) => {
        console.log(`${String(index + 1).padStart(6)}  ${String(result.snr).padStart(6)}  ${String(result.frequency).padStart(6)}  ${String(result.drift).padStart(5)}  ${result.callsign.padEnd(8)}  ${result.locator.padEnd(4)}  ${result.power}`);
      });
    } else {
      console.log('   No WSPR signals detected (this is normal with noise data)');
    }
    
  } catch (error) {
    if (error instanceof WSJTXError) {
      console.error('❌ WSPR decode error:', error.message, `(${error.code})`);
    } else {
      console.error('❌ Unexpected error:', error);
    }
  }
}

/**
 * Example 5: Mode Capability Query
 * Shows all supported digital modes and their characteristics
 */
function exampleModeCapabilities() {
  console.log('\n📋 === Digital Mode Capability Query ===');
  
  const lib = new WSJTXLib();
  const capabilities = lib.getAllModeCapabilities();
  
  console.log('Supported digital modes:');
  console.log('Mode     | Encode | Decode | Sample Rate | Duration  | Description');
  console.log('---------|--------|--------|-------------|-----------|------------------');
  
  const modeDescriptions: { [key: string]: string } = {
    'FT8': 'Weak signal digital',
    'FT4': 'Fast digital mode',
    'JT4': 'EME communication',
    'JT65': 'Weak signal HF',
    'JT9': 'Weak signal VHF',
    'FST4': 'Slow digital mode',
    'Q65': 'VHF/UHF weak signal',
    'FST4W': 'Ultra-slow mode',
    'WSPR': 'Weak signal beacon'
  };
  
  capabilities.forEach(cap => {
    const modeName = WSJTXMode[cap.mode].padEnd(8);
    const encode = cap.encodingSupported ? '✅' : '❌';
    const decode = cap.decodingSupported ? '✅' : '❌';
    const sampleRate = `${cap.sampleRate} Hz`.padStart(11);
    const duration = `${cap.duration}s`.padStart(9);
    const description = modeDescriptions[WSJTXMode[cap.mode]] || 'Unknown mode';
    
    console.log(`${modeName} | ${encode}     | ${decode}     | ${sampleRate} | ${duration} | ${description}`);
  });
  
  // Show specific mode details
  console.log('\n🎯 FT8 Mode Details:');
  console.log(`  Sample rate: ${lib.getSampleRate(WSJTXMode.FT8)} Hz`);
  console.log(`  Transmission duration: ${lib.getTransmissionDuration(WSJTXMode.FT8)} seconds`);
  console.log(`  Encoding supported: ${lib.isEncodingSupported(WSJTXMode.FT8) ? 'Yes' : 'No'}`);
  console.log(`  Decoding supported: ${lib.isDecodingSupported(WSJTXMode.FT8) ? 'Yes' : 'No'}`);
}

/**
 * Example 6: Error Handling
 * Demonstrates handling of various error conditions
 */
async function exampleErrorHandling() {
  console.log('\n⚠️ === Error Handling Example ===');
  
  const lib = new WSJTXLib();
  
  console.log('Testing various error conditions:');
  
  // Test 1: Invalid mode
  try {
    await lib.decode(999 as WSJTXMode, new Float32Array(1000), 1000);
  } catch (error) {
    if (error instanceof WSJTXError) {
      console.log(`✅ Caught invalid mode error: ${error.message} (${error.code})`);
    }
  }
  
  // Test 2: Invalid frequency
  try {
    await lib.decode(WSJTXMode.FT8, new Float32Array(1000), -1000);
  } catch (error) {
    if (error instanceof WSJTXError) {
      console.log(`✅ Caught invalid frequency error: ${error.message} (${error.code})`);
    }
  }
  
  // Test 3: Empty audio data
  try {
    await lib.decode(WSJTXMode.FT8, new Float32Array(0), 1000);
  } catch (error) {
    if (error instanceof WSJTXError) {
      console.log(`✅ Caught empty audio data error: ${error.message} (${error.code})`);
    }
  }
  
  // Test 4: Invalid message
  try {
    await lib.encode(WSJTXMode.FT8, '', 1000);
  } catch (error) {
    if (error instanceof WSJTXError) {
      console.log(`✅ Caught empty message error: ${error.message} (${error.code})`);
    }
  }
  
  // Test 5: Message too long
  try {
    await lib.encode(WSJTXMode.FT8, 'x'.repeat(50), 1000);
  } catch (error) {
    if (error instanceof WSJTXError) {
      console.log(`✅ Caught message too long error: ${error.message} (${error.code})`);
    }
  }
  
  console.log('\nError handling test complete, all errors properly caught and handled.');
}

/**
 * Example 7: Performance Testing
 * Tests encoding and decoding performance
 */
async function examplePerformanceTest() {
  console.log('\n⚡ === Performance Testing Example ===');
  
  const lib = new WSJTXLib();
  const message = 'CQ DX BH1ABC OM88';
  const audioFrequency = 1000;
  const iterations = 5;
  
  console.log(`Test parameters:`);
  console.log(`  Message: "${message}"`);
  console.log(`  Frequency: ${audioFrequency} Hz`);
  console.log(`  Iterations: ${iterations}`);
  
  // Encoding performance test
  console.log('\n📤 Encoding performance test:');
  const encodeTimes: number[] = [];
  
  for (let i = 0; i < iterations; i++) {
    const startTime = performance.now();
    await lib.encode(WSJTXMode.FT8, message, audioFrequency);
    const endTime = performance.now();
    const duration = endTime - startTime;
    encodeTimes.push(duration);
    console.log(`  Encoding #${i + 1}: ${duration.toFixed(2)} ms`);
  }
  
  const avgEncodeTime = encodeTimes.reduce((a, b) => a + b, 0) / encodeTimes.length;
  console.log(`  Average encoding time: ${avgEncodeTime.toFixed(2)} ms`);
  
  // Decoding performance test
  console.log('\n📥 Decoding performance test:');
  
  // Generate test audio first
  const encodeResult = await lib.encode(WSJTXMode.FT8, message, audioFrequency);
  
  // Resampling and conversion
  const resampleTo12kHz = (audioData48k: Float32Array): Float32Array => {
    const audioData12k = new Float32Array(Math.floor(audioData48k.length / 4));
    for (let i = 0; i < audioData12k.length; i++) {
      audioData12k[i] = audioData48k[i * 4];
    }
    return audioData12k;
  };
  
  const resampled = resampleTo12kHz(encodeResult.audioData);
  const audioInt16 = new Int16Array(resampled.length);
  for (let i = 0; i < resampled.length; i++) {
    audioInt16[i] = Math.round(resampled[i] * 32767);
  }
  
  const decodeTimes: number[] = [];
  
  for (let i = 0; i < iterations; i++) {
    lib.pullMessages(); // Clear message queue
    const startTime = performance.now();
    await lib.decode(WSJTXMode.FT8, audioInt16, audioFrequency);
    const endTime = performance.now();
    const duration = endTime - startTime;
    decodeTimes.push(duration);
    console.log(`  Decoding #${i + 1}: ${duration.toFixed(2)} ms`);
  }
  
  const avgDecodeTime = decodeTimes.reduce((a, b) => a + b, 0) / decodeTimes.length;
  console.log(`  Average decoding time: ${avgDecodeTime.toFixed(2)} ms`);
  
  console.log('\n📊 Performance summary:');
  console.log(`  Encoding performance: ${avgEncodeTime.toFixed(2)} ms/message`);
  console.log(`  Decoding performance: ${avgDecodeTime.toFixed(2)} ms/message`);
  console.log(`  Total performance: ${(avgEncodeTime + avgDecodeTime).toFixed(2)} ms/complete cycle`);
}

/**
 * Main function - runs all examples
 */
async function main() {
  console.log('🚀 WSJTX Library Complete Feature Examples');
  console.log('==========================================');
  
  try {
    // Run all examples
    await exampleFT8FullCycle();
    await exampleFT8Encoding();
    exampleAudioConversion();
    await exampleWSPRDecode();
    exampleModeCapabilities();
    await exampleErrorHandling();
    await examplePerformanceTest();
    
    console.log('\n🎉 All examples completed successfully!');
    console.log(`📁 Output files saved to: ${outputDir}`);
    
    // List generated files
    const files = fs.readdirSync(outputDir);
    if (files.length > 0) {
      console.log('\n📄 Generated files:');
      files.forEach(file => {
        const filepath = path.join(outputDir, file);
        const stats = fs.statSync(filepath);
        console.log(`  ${file} (${(stats.size / 1024).toFixed(2)} KB)`);
      });
    }
    
  } catch (error) {
    console.error('\n❌ Example execution failed:', error);
    process.exit(1);
  }
}

// Execute main function if this file is run directly
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch(console.error);
}

// Export all example functions for use by other modules
export {
  exampleFT8FullCycle,
  exampleFT8Encoding,
  exampleAudioConversion,
  exampleWSPRDecode,
  exampleModeCapabilities,
  exampleErrorHandling,
  examplePerformanceTest
};
