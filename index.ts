export enum RepeatMode {
  noRepeat = 0,
  repeatOnce = 1,
  repeatFull = 2,
}

export interface PlayerTrack {
  id: string;
  url: string;
}

interface PlayerState<Track extends PlayerTrack = PlayerTrack> {
  volume: number;
  isPaused: boolean;
  position: number;
  repeatMode: RepeatMode;
  isShuffled: boolean;
  currentTrack?: Track;
  // Priority tracks are not affected by shuffle
  priorityTracks: Track[];
  // Tracks next up in the queue
  nextTracks: Track[];
  // Tracks previously played or skipped due to play index
  previousTracks: Track[];
}

interface PlayerError<Track extends PlayerTrack = PlayerTrack> {
  message: string;
  track?: Track;
  event?: Event | string;
  error?: Error;
}

interface PlayerParams<Track extends PlayerTrack = PlayerTrack> {
  volume: number;
  onTrackStart?: (track: Track) => void;
  onTrackEnd?: (track: Track) => void;
  onStateChanged?: (state: PlayerState<Track>) => void;
  onError?: (error: PlayerError<Track>) => void;
  // Optionally override default shuffle logic
  shuffle?: (nonShuffledNextTracks: Track[], state: PlayerState<Track>) => Track[];
}

export function getTimeDisplay(seconds: number): string {
  let remainingTime = seconds;
  if (!Number.isFinite(seconds)) {
    remainingTime = 0;
  }

  let result = '';
  if (seconds >= 3600) {
    remainingTime %= 3600;
    result += `${Math.floor(seconds / 3600)}:`;
  }

  const minutes = Math.floor(remainingTime / 60);
  remainingTime %= 60;
  if (result && minutes < 10) {
    result += '0';
  }

  result += `${minutes}:`;

  if (remainingTime < 10) {
    result += '0';
  }

  result += Math.floor(remainingTime);

  return result;
}

export class Player<Track extends PlayerTrack = PlayerTrack> {
  private readonly state: PlayerState<Track>;

  private readonly onTrackStart?: (track: Track) => void;

  private readonly onTrackEnd?: (track: Track) => void;

  private readonly onStateChanged?: (state: PlayerState<Track>) => void;

  private readonly onError?: (error: PlayerError<Track>) => void;

  private readonly shuffle?: (nonShuffledNextTracks: Track[], state: PlayerState<Track>) => Track[];

  private isAudio1Active = true;

  private audio1: HTMLAudioElement | null;

  private audio2: HTMLAudioElement | null;

  private nonShuffledNextTracks: Track[] = [];

  public constructor({ volume, onTrackStart, onTrackEnd, onStateChanged, onError, shuffle }: PlayerParams<Track>) {
    this.audio1 = null;
    this.audio2 = null;

    this.state = {
      volume,
      isPaused: true,
      position: 0,
      repeatMode: RepeatMode.noRepeat,
      isShuffled: false,
      priorityTracks: [],
      nextTracks: [],
      previousTracks: [],
    };

    this.onTrackStart = onTrackStart;
    this.onTrackEnd = onTrackEnd;
    this.onStateChanged = onStateChanged;
    this.onError = onError;

    this.shuffle = shuffle;
  }

  public setVolume(volumePercent: number): void {
    try {
      this.state.volume = volumePercent;
      const volume = volumePercent / 100;
      if (this.audio1) {
        this.audio1.volume = volume;
      }

      if (this.audio2) {
        this.audio2.volume = volume;
      }

      this.triggerOnStateChange();
    } catch (ex) {
      if (this.onError) {
        this.onError(ex);
      }
    }
  }

  public setRepeatMode(repeatMode: RepeatMode): void {
    try {
      this.state.repeatMode = repeatMode;
      const audio = this.activeAudioElement;

      if (audio) {
        audio.loop = repeatMode !== RepeatMode.noRepeat;
      }

      this.triggerOnStateChange();
    } catch (ex) {
      if (this.onError) {
        this.onError(ex);
      }
    }
  }

  public enableShuffle(): void {
    this.state.isShuffled = true;
    if (this.shuffle) {
      this.state.nextTracks = this.shuffle(this.nonShuffledNextTracks.slice(), { ...this.state });
    } else {
      this.state.nextTracks = this.defaultShuffle(this.nonShuffledNextTracks);
    }

    this.triggerOnStateChange();
  }

  public disableShuffle(): void {
    this.state.isShuffled = false;
    this.state.nextTracks = this.nonShuffledNextTracks;

    this.triggerOnStateChange();
  }

  public pause(): void {
    try {
      const audio = this.activeAudioElement;
      if (audio) {
        audio.pause();
      }

      if (!this.state.isPaused) {
        this.state.isPaused = true;
        this.triggerOnStateChange();
      }
    } catch (ex) {
      if (this.onError) {
        this.onError(ex);
      }
    }
  }

  public async play(): Promise<void> {
    try {
      const audio = this.activeAudioElement;
      if (audio) {
        await audio.play();
        this.state.isPaused = false;

        this.triggerOnStateChange();
      } else {
        await this.playNextTrack(this.state.currentTrack);
      }
    } catch (ex) {
      if (this.onError) {
        this.onError(ex);
      }
    }
  }

  public async togglePlay(): Promise<void> {
    if (this.state.isPaused) {
      await this.play();
    } else {
      this.pause();
    }
  }

  public seek(position: number): void {
    try {
      const audio = this.activeAudioElement;
      if (audio) {
        audio.currentTime = Math.max(0, position);

        this.triggerOnStateChange();
      }
    } catch (ex) {
      if (this.onError) {
        this.onError(ex);
      }
    }
  }

  public async previousTrack(): Promise<void> {
    try {
      const audio = this.activeAudioElement;
      if (audio) {
        audio.pause();

        // If the current song has played for more than 3 seconds, rewind it to the beginning
        // If there are no previously played tracks, rewind the current track
        if (audio.currentTime >= 3 || !this.state.previousTracks.length) {
          audio.currentTime = 0;

          if (this.state.currentTrack) {
            this.triggerOnTrackStart();
          }

          await this.play();
          return;
        }

        // Remove event hook since the active audio element will become a buffer
        audio.oncanplaythrough = null;
        audio.currentTime = 0;
      }

      if (this.state.previousTracks.length) {
        // If a song was playing, prepend it back to to nextTracks
        if (this.state.currentTrack) {
          this.state.nextTracks = [this.state.currentTrack, ...this.state.nextTracks];

          this.triggerOnTrackEnd(this.state.currentTrack);
        }

        // Pop last played track and make it the current track
        // NOTE: saving to currentTrack to prevent playNextTrack from re-adding to previousTracks
        this.state.currentTrack = this.state.previousTracks.shift();
        await this.playNextTrack(this.state.currentTrack);
      }
    } catch (ex) {
      if (this.onError) {
        this.onError(ex);
      }
    }
  }

  public async nextTrack(): Promise<void> {
    try {
      const audio = this.activeAudioElement;
      if (audio) {
        audio.pause();
        this.state.isPaused = true;
      }

      await this.playNextTrack();
    } catch (ex) {
      if (this.onError) {
        this.onError(ex);
      }
    }
  }

  public queuePriorityTracks(tracks: Track[]): void {
    const hadPriorityTracks = !!this.state.priorityTracks.length;
    this.state.priorityTracks = [...this.state.priorityTracks, ...tracks];

    // If there were no previous priority tracks, replace buffer with first priority track
    if (!hadPriorityTracks) {
      if ((this.isAudio1Active && this.audio2) || (!this.isAudio1Active && this.audio1)) {
        this.bufferNextTrack();
      }
    }

    this.triggerOnStateChange();
  }

  public removePriorityTrack(id: string): void {
    this.state.priorityTracks = this.state.priorityTracks.filter((track: Track): boolean => track.id !== id);
    this.triggerOnStateChange();
  }

  public clearPriorityTracks(): void {
    this.state.priorityTracks = [];
    this.triggerOnStateChange();
  }

  /**
   * NOTE: This will clear priorityTracks and previousTracks. If playIndex is specified, tracks before playIndex
   * will be assigned to previousTracks.
   * @param {object[]} tracks
   * @param {number} [playIndex=0]
   */
  public async playTracks(tracks: Track[], playIndex = 0): Promise<void> {
    const audio = this.activeAudioElement;
    if (audio) {
      audio.pause();
    }

    this.audio1 = null;
    this.audio2 = null;
    this.isAudio1Active = true;

    this.state.priorityTracks = [];
    if (playIndex > 0 && playIndex < tracks.length) {
      this.state.previousTracks = tracks.slice(0, playIndex - 1);
    } else {
      this.state.previousTracks = [];
    }

    this.state.nextTracks = tracks.slice(playIndex);

    await this.play();
  }

  private get activeAudioElement(): HTMLAudioElement | null {
    if (this.isAudio1Active) {
      return this.audio1;
    }

    return this.audio2;
  }

  private onPlayerProgress(): void {
    const audio = this.activeAudioElement;
    if (audio) {
      this.state.position = audio.currentTime;
    } else {
      this.state.position = 0;
    }

    this.triggerOnStateChange();
  }

  private onPlayerTrackEnd(): void {
    switch (this.state.repeatMode) {
      case RepeatMode.repeatOnce:
        this.setRepeatMode(RepeatMode.noRepeat);
        break;
      case RepeatMode.noRepeat:
        this.playNextTrack().catch((err): void => {
          if (this.onError) {
            this.onError(err);
          }
        });
        break;
      case RepeatMode.repeatFull:
      default:
        break;
    }
  }

  private async playNextTrack(manualNextTrack?: Track): Promise<void> {
    let nextTrack = manualNextTrack;

    if (!nextTrack) {
      if (this.state.priorityTracks.length) {
        nextTrack = this.state.priorityTracks.shift();
      } else if (this.state.nextTracks.length) {
        nextTrack = this.state.nextTracks.shift();

        if (!this.state.isShuffled) {
          this.nonShuffledNextTracks = this.state.nextTracks;
        }
      }
    }

    if (this.state.currentTrack && (!nextTrack || this.state.currentTrack.id !== nextTrack.id)) {
      this.state.previousTracks = [this.state.currentTrack, ...this.state.previousTracks];

      this.triggerOnTrackEnd(this.state.currentTrack);
    }

    if (nextTrack) {
      this.state.currentTrack = nextTrack;
      this.isAudio1Active = !this.isAudio1Active;

      let audio: HTMLAudioElement;
      // Create the audio element if it was not previously buffered
      if (this.isAudio1Active) {
        if (!this.audio1) {
          this.audio1 = new Audio();
        }

        audio = this.audio1;
      } else {
        if (!this.audio2) {
          this.audio2 = new Audio();
        }

        audio = this.audio2;
      }

      if (this.onError && !audio.onerror) {
        audio.onerror = (event: Event | string, _source?: string, _lineno?: number, _colno?: number, error?: Error): void => {
          if (this.onError) {
            this.onError(
              error || {
                message: `Error loading audio: ${nextTrack ? nextTrack.url : 'Unknown track :('}`,
                event,
                error,
              },
            );
          }
        };
      }

      audio.oncanplaythrough = (): void => {
        this.bufferNextTrack();
      };

      audio.onprogress = (): void => {
        this.onPlayerProgress();
      };

      audio.onended = (): void => {
        this.onPlayerTrackEnd();
      };

      audio.volume = this.state.volume;
      audio.src = nextTrack.url;
      audio.currentTime = 0;

      // Destroy the previous track audio element
      if (!manualNextTrack) {
        if (this.isAudio1Active && this.audio2) {
          this.audio2.onerror = null;
          this.audio2.onprogress = null;
          this.audio2.onended = null;
          this.audio2.oncanplaythrough = null;
          this.audio2 = null;
        } else if (!this.isAudio1Active && this.audio1) {
          this.audio1.onerror = null;
          this.audio1.onprogress = null;
          this.audio1.onended = null;
          this.audio1.oncanplaythrough = null;
          this.audio1 = null;
        }
      }

      this.triggerOnTrackStart();

      await this.play();
    } else if (this.state.currentTrack) {
      this.state.currentTrack = undefined;
      this.triggerOnStateChange();
    }
  }

  private bufferNextTrack(): void {
    let nextTrack: Track | undefined;
    if (this.state.priorityTracks.length) {
      [nextTrack] = this.state.priorityTracks.slice(0, 1);
    } else if (this.state.nextTracks.length) {
      [nextTrack] = this.state.nextTracks.slice(0, 1);
    }

    if (nextTrack) {
      let buffer: HTMLAudioElement;
      if (this.isAudio1Active) {
        // Destroy previous buffer if it's not buffering the correct track
        if (this.audio2 && this.audio2.src !== nextTrack.url) {
          this.audio2.onerror = null;
          this.audio2.onprogress = null;
          this.audio2.onended = null;
          this.audio2.oncanplaythrough = null;
          this.audio2 = null;
        }

        if (!this.audio2) {
          this.audio2 = new Audio();
        }

        buffer = this.audio2;
      } else {
        // Destroy previous buffer if it's not buffering the correct track
        if (this.audio1 && this.audio1.src !== nextTrack.url) {
          this.audio1.onerror = null;
          this.audio1.onprogress = null;
          this.audio1.onended = null;
          this.audio1.oncanplaythrough = null;
          this.audio1 = null;
        }

        if (!this.audio1) {
          this.audio1 = new Audio();
        }

        buffer = this.audio1;
      }

      if (this.onError && !buffer.onerror) {
        buffer.onerror = (event: Event | string, _source?: string, _lineno?: number, _colno?: number, error?: Error): void => {
          if (this.onError) {
            this.onError(
              error || {
                message: `Error loading audio: ${nextTrack ? nextTrack.url : 'Unknown track :('}`,
                event,
                error,
              },
            );
          }
        };
      }

      buffer.preload = 'auto';
      buffer.src = nextTrack.url;
    }
  }

  private defaultShuffle(nonShuffledNextTracks: Track[]): Track[] {
    const shuffledTrackList = nonShuffledNextTracks.slice();
    let currentIndex = shuffledTrackList.length;

    // From: https://stackoverflow.com/a/2450976/3085
    while (currentIndex !== 0) {
      const randomIndex = Math.floor(Math.random() * currentIndex);
      currentIndex -= 1;

      const tempValue = shuffledTrackList[currentIndex];
      shuffledTrackList[currentIndex] = shuffledTrackList[randomIndex];
      shuffledTrackList[randomIndex] = tempValue;
    }

    return shuffledTrackList;
  }

  private triggerOnTrackStart(): void {
    if (this.onTrackStart && this.state.currentTrack) {
      this.onTrackStart(this.state.currentTrack);
    }
  }

  private triggerOnTrackEnd(track: Track): void {
    if (this.onTrackEnd) {
      this.onTrackEnd(track);
    }
  }

  private triggerOnStateChange(): void {
    if (this.onStateChanged) {
      this.onStateChanged({ ...this.state });
    }
  }
}
