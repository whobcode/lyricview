import { Buffer } from 'node:buffer';

interface Env {
	AI: Ai;
	ASSETS: Fetcher;
}

interface TranscriptionResult {
	text: string;
	vtt?: string;
	word_count?: number;
}

export default {
	async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
		const url = new URL(request.url);

		// Handle transcription API endpoint
		if (url.pathname === '/transcribe' && request.method === 'POST') {
			return handleTranscribe(request, env);
		}

		// Let the assets binding handle static files
		return env.ASSETS.fetch(request);
	},
} satisfies ExportedHandler<Env>;

async function handleTranscribe(request: Request, env: Env): Promise<Response> {
	try {
		const contentType = request.headers.get('content-type') || '';

		if (!contentType.includes('multipart/form-data')) {
			return jsonError('Content-Type must be multipart/form-data', 400);
		}

		const formData = await request.formData();
		const audioFile = formData.get('audio');

		if (!audioFile || !(audioFile instanceof File)) {
			return jsonError('No audio file provided', 400);
		}

		// Validate file type by MIME type or extension
		const validAudioExtensions = [
			'.mp3', '.m4a', '.wav', '.ogg', '.flac', '.aac',
			'.wma', '.opus', '.webm', '.mp4', '.mpeg', '.mpga'
		];
		const fileName = audioFile.name.toLowerCase();
		const hasValidExtension = validAudioExtensions.some(ext => fileName.endsWith(ext));
		const hasValidMimeType = audioFile.type.startsWith('audio/') ||
			audioFile.type.startsWith('video/') || // m4a can be detected as video/mp4
			audioFile.type === 'application/octet-stream'; // fallback for unknown types

		if (!hasValidExtension && !hasValidMimeType) {
			return jsonError('File must be an audio file (mp3, m4a, wav, ogg, flac, aac, etc.)', 400);
		}

		// Validate file size (25MB limit)
		if (audioFile.size > 25 * 1024 * 1024) {
			return jsonError('File size must be less than 25MB', 400);
		}

		// Convert audio to base64
		const arrayBuffer = await audioFile.arrayBuffer();
		const base64Audio = Buffer.from(arrayBuffer).toString('base64');

		// Call Workers AI Whisper model
		const result = await env.AI.run('@cf/openai/whisper-large-v3-turbo', {
			audio: base64Audio,
		}) as TranscriptionResult;

		// Format lyrics for better readability
		const formattedText = formatLyrics(result.text, result.vtt);

		return new Response(JSON.stringify({
			text: formattedText,
			vtt: result.vtt,
			word_count: result.word_count,
		}), {
			headers: {
				'Content-Type': 'application/json',
			},
		});
	} catch (error) {
		console.error('Transcription error:', error);
		const message = error instanceof Error ? error.message : 'Transcription failed';
		return jsonError(message, 500);
	}
}

function jsonError(message: string, status: number): Response {
	return new Response(JSON.stringify({ error: message }), {
		status,
		headers: {
			'Content-Type': 'application/json',
		},
	});
}

function formatLyrics(text: string, vtt?: string): string {
	if (!text) return text;

	// Try to use VTT timing to detect natural breaks
	if (vtt) {
		const lines = parseVttToLines(vtt);
		if (lines.length > 0) {
			return formatWithTiming(lines);
		}
	}

	// Fallback: format based on punctuation and patterns
	return formatByPunctuation(text);
}

interface VttLine {
	start: number;
	end: number;
	text: string;
}

function parseVttToLines(vtt: string): VttLine[] {
	const lines: VttLine[] = [];
	// Match format: 00:08.340 --> 00:08.860 or 01:30.500 --> 01:31.000
	const regex = /(\d{2}):(\d{2})\.(\d{3})\s*-->\s*(\d{2}):(\d{2})\.(\d{3})\n(.+?)(?=\n\n|\n\d|$)/gs;

	let match;
	while ((match = regex.exec(vtt)) !== null) {
		const startMin = parseInt(match[1]);
		const startSec = parseInt(match[2]);
		const startMs = parseInt(match[3]);
		const endMin = parseInt(match[4]);
		const endSec = parseInt(match[5]);
		const endMs = parseInt(match[6]);
		const text = match[7].trim();

		lines.push({
			start: startMin * 60 + startSec + startMs / 1000,
			end: endMin * 60 + endSec + endMs / 1000,
			text: text,
		});
	}

	return lines;
}

function formatWithTiming(lines: VttLine[]): string {
	const result: string[] = [];
	let currentLine: string[] = [];
	let currentVerse: string[] = [];
	const MAX_WORDS_PER_LINE = 10;
	const MAX_LINES_PER_VERSE = 4;

	for (let i = 0; i < lines.length; i++) {
		currentLine.push(lines[i].text);

		let shouldBreakLine = false;
		let shouldBreakVerse = false;

		// Check for pause before next word
		if (i < lines.length - 1) {
			const gap = lines[i + 1].start - lines[i].end;

			if (gap > 0.8) {
				// Long pause = new verse
				shouldBreakVerse = true;
				shouldBreakLine = true;
			} else if (gap > 0.3) {
				// Medium pause = new line
				shouldBreakLine = true;
			}
		}

		// Also break line if we hit max words
		if (currentLine.length >= MAX_WORDS_PER_LINE) {
			shouldBreakLine = true;
		}

		if (shouldBreakLine && currentLine.length > 0) {
			currentVerse.push(currentLine.join(' '));
			currentLine = [];
		}

		if (shouldBreakVerse && currentVerse.length > 0) {
			result.push(currentVerse.join('\n'));
			result.push(''); // Empty line for verse break
			currentVerse = [];
		}

		// Also break verse if we hit max lines
		if (currentVerse.length >= MAX_LINES_PER_VERSE) {
			result.push(currentVerse.join('\n'));
			result.push('');
			currentVerse = [];
		}
	}

	// Add remaining words/lines
	if (currentLine.length > 0) {
		currentVerse.push(currentLine.join(' '));
	}
	if (currentVerse.length > 0) {
		result.push(currentVerse.join('\n'));
	}

	return result.join('\n').trim();
}

function formatByPunctuation(text: string): string {
	// Split on sentence endings and add line breaks
	let formatted = text
		// Add line break after sentence endings
		.replace(/([.!?])\s+/g, '$1\n')
		// Add line break after commas followed by common lyric patterns
		.replace(/,\s+(and|but|so|cause|because|when|if|I|you|we|they|oh|yeah|baby|now)\s/gi, ',\n$1 ')
		// Add extra break for repeated patterns (likely chorus)
		.replace(/(\n.+)\1/g, '$1\n$1');

	// Group into verses (roughly every 4 lines)
	const lines = formatted.split('\n').filter(l => l.trim());
	const verses: string[] = [];
	let currentVerse: string[] = [];

	for (let i = 0; i < lines.length; i++) {
		currentVerse.push(lines[i].trim());

		if (currentVerse.length >= 4) {
			verses.push(currentVerse.join('\n'));
			currentVerse = [];
		}
	}

	if (currentVerse.length > 0) {
		verses.push(currentVerse.join('\n'));
	}

	return verses.join('\n\n');
}
