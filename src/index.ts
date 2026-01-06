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

		return new Response(JSON.stringify({
			text: result.text,
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
