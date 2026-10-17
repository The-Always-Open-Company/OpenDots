import { useCallback, useEffect, useRef, useState } from 'react';
import type { Message } from '@ag-ui/core';
import { postForBlob } from './api';
import { speakableText } from '../shared/voice-note';

/** Plays one spoken reply at a time; audio is cached in memory for replay only. */
export function useSpokenReply() {
  const [playingId, setPlayingId] = useState('');
  const [loadingId, setLoadingId] = useState('');
  const [error, setError] = useState('');
  const audio = useRef<HTMLAudioElement | null>(null);
  const cache = useRef(new Map<string, string>());
  const request = useRef<AbortController | null>(null);

  const stop = useCallback(() => {
    request.current?.abort();
    request.current = null;
    audio.current?.pause();
    audio.current = null;
    setPlayingId('');
    setLoadingId('');
  }, []);

  const play = useCallback(
    async (message: Pick<Message, 'id' | 'content'>) => {
      stop();
      const text =
        typeof message.content === 'string'
          ? speakableText(message.content)
          : '';
      if (!text) return;
      setError('');
      let url = cache.current.get(message.id);
      if (!url) {
        const controller = new AbortController();
        request.current = controller;
        setLoadingId(message.id);
        try {
          url = URL.createObjectURL(
            await postForBlob('/voice/speech', { text }, controller.signal),
          );
        } catch (e) {
          if (!controller.signal.aborted) {
            setLoadingId('');
            setError(
              e instanceof Error
                ? `Spoken reply failed: ${e.message}`
                : 'Spoken reply failed.',
            );
          }
          return;
        }
        if (controller.signal.aborted) {
          URL.revokeObjectURL(url);
          return;
        }
        request.current = null;
        cache.current.set(message.id, url);
        setLoadingId('');
      }
      const player = new Audio(url);
      audio.current = player;
      player.onended = () => {
        if (audio.current === player) {
          audio.current = null;
          setPlayingId('');
        }
      };
      setPlayingId(message.id);
      await player.play().catch(() => {
        if (audio.current !== player) return;
        audio.current = null;
        setPlayingId('');
        setError('The browser blocked playback. Press play to hear the reply.');
      });
    },
    [stop],
  );

  useEffect(() => {
    const urls = cache.current;
    return () => {
      stop();
      for (const url of urls.values()) URL.revokeObjectURL(url);
      urls.clear();
    };
  }, [stop]);

  return { playingId, loadingId, error, play, stop };
}
