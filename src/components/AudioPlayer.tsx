import React, { useState, useRef, useEffect } from 'react';
import { Volume2, Play, Pause, Loader2 } from 'lucide-react';

interface Props {
  briefingText: string;
  storyTitle: string;
}

export const AudioPlayer: React.FC<Props> = ({ briefingText, storyTitle }) => {
  const [isPlaying, setIsPlaying] = useState(false);
  const [loading, setLoading] = useState(false);
  const [audioUrl, setAudioUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);

  const fetchAudio = async () => {
    if (audioUrl) {
      if (audioRef.current) {
        if (isPlaying) {
          audioRef.current.pause();
          setIsPlaying(false);
        } else {
          audioRef.current.play();
          setIsPlaying(true);
        }
      }
      return;
    }

    setLoading(true);
    setError(null);

    try {
      const res = await fetch('/api/audio-briefing', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          text: `Here is your SerpNews 45-second flash briefing on ${storyTitle}. ${briefingText.slice(0, 350)}`,
        }),
      });

      if (!res.ok) throw new Error('Audio generation unavailable');

      const data = await res.json();
      if (!data.audioBase64) throw new Error('No audio data received');

      const byteCharacters = atob(data.audioBase64);
      const byteNumbers = new Array(byteCharacters.length);
      for (let i = 0; i < byteCharacters.length; i++) {
        byteNumbers[i] = byteCharacters.charCodeAt(i);
      }
      const byteArray = new Uint8Array(byteNumbers);
      const blob = new Blob([byteArray], { type: data.mimeType || 'audio/wav' });
      const url = URL.createObjectURL(blob);

      setAudioUrl(url);
      setIsPlaying(true);
    } catch (err: any) {
      console.warn('Audio generation failed, falling back to speech synthesis:', err);
      if ('speechSynthesis' in window) {
        window.speechSynthesis.cancel();
        const utter = new SpeechSynthesisUtterance(`SerpNews Flash Briefing: ${storyTitle}. ${briefingText}`);
        utter.rate = 1.05;
        utter.onend = () => setIsPlaying(false);
        utter.onerror = () => setIsPlaying(false);
        window.speechSynthesis.speak(utter);
        setIsPlaying(true);
      } else {
        setError('Audio playback not supported');
      }
    } finally {
      setLoading(false);
    }
  };

  const handleStop = () => {
    if ('speechSynthesis' in window) {
      window.speechSynthesis.cancel();
    }
    if (audioRef.current) {
      audioRef.current.pause();
    }
    setIsPlaying(false);
  };

  useEffect(() => {
    return () => {
      if (audioUrl) {
        URL.revokeObjectURL(audioUrl);
      }
      if ('speechSynthesis' in window) {
        window.speechSynthesis.cancel();
      }
    };
  }, [audioUrl]);

  return (
    <div className="flex items-center gap-3 bg-[#ede3d4] border border-[#dfd0be] rounded-xl px-3 py-2 text-xs text-[#4a342a] shadow-xs">
      {audioUrl && (
        <audio
          ref={audioRef}
          src={audioUrl}
          onEnded={() => setIsPlaying(false)}
          onError={() => setIsPlaying(false)}
        />
      )}

      <button
        onClick={isPlaying ? handleStop : fetchAudio}
        disabled={loading}
        className="flex items-center justify-center w-8 h-8 rounded-lg bg-[#881326] hover:bg-[#6b0f1a] text-white transition disabled:opacity-50 cursor-pointer shadow-sm"
        title={isPlaying ? "Pause briefing" : "Listen to 45s audio briefing"}
      >
        {loading ? (
          <Loader2 className="w-4 h-4 animate-spin text-white" />
        ) : isPlaying ? (
          <Pause className="w-4 h-4 fill-current" />
        ) : (
          <Play className="w-4 h-4 fill-current ml-0.5" />
        )}
      </button>

      <div className="flex flex-col">
        <div className="flex items-center gap-1.5 font-bold text-[#2d1b15]">
          <Volume2 className="w-3.5 h-3.5 text-[#881326]" />
          <span>45-Sec Flash Briefing</span>
          {isPlaying && (
            <span className="flex items-center gap-0.5 ml-1">
              <span className="w-1 h-3 bg-[#881326] rounded-full animate-bounce [animation-delay:-0.3s]"></span>
              <span className="w-1 h-4 bg-[#881326] rounded-full animate-bounce [animation-delay:-0.15s]"></span>
              <span className="w-1 h-2 bg-[#881326] rounded-full animate-bounce"></span>
            </span>
          )}
        </div>
        <span className="text-[10px] text-[#715c50]">
          {isPlaying ? 'Playing SerpNews audio brief...' : 'Listen instead of reading'}
        </span>
      </div>

      {error && <span className="text-[10px] text-[#b91c1c] ml-auto">{error}</span>}
    </div>
  );
};
