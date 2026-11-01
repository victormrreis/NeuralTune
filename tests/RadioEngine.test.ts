import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MemoryStorage } from '../src/storage/MemoryStorage.ts';
import { BlacklistManager } from '../src/core/BlacklistManager.ts';
import { PreferenceEngine } from '../src/core/PreferenceEngine.ts';
import { RadioEngine } from '../src/radios/RadioEngine.ts';
import { TrackMetadata } from '../src/types/index.ts';

test('RadioEngine: Gym preset filters high energy and fast BPM', () => {
  const storage = new MemoryStorage();
  const blacklist = new BlacklistManager(storage);
  const preference = new PreferenceEngine(storage);
  const radio = new RadioEngine(preference, blacklist);

  const candidates: TrackMetadata[] = [
    {
      uri: 'gym_track',
      name: 'High Energy Workout',
      artists: [{ name: 'DJ Pump', uri: 'art1' }],
      album: { name: '', uri: '' },
      acousticFeatures: { bpm: 130, energy: 0.85 }
    },
    {
      uri: 'slow_track',
      name: 'Chill Ambient',
      artists: [{ name: 'Calm', uri: 'art2' }],
      album: { name: '', uri: '' },
      acousticFeatures: { bpm: 75, energy: 0.2 }
    }
  ];

  const result = radio.generateRadio(candidates, 'gym');
  assert.equal(result.tracks.length, 1);
  assert.equal(result.tracks[0].uri, 'gym_track');
  assert.equal(result.discardedCount, 1);
});

test('RadioEngine: Study preset filters exclusively instrumental tracks', () => {
  const storage = new MemoryStorage();
  const blacklist = new BlacklistManager(storage);
  const preference = new PreferenceEngine(storage);
  const radio = new RadioEngine(preference, blacklist);

  const candidates: TrackMetadata[] = [
    {
      uri: 'vocal_track',
      name: 'Vocal Pop',
      artists: [],
      album: { name: '', uri: '' },
      acousticFeatures: { instrumentalness: 0.05, energy: 0.4 }
    },
    {
      uri: 'piano_track',
      name: 'Piano Solo',
      artists: [],
      album: { name: '', uri: '' },
      acousticFeatures: { instrumentalness: 0.95, energy: 0.3 }
    }
  ];

  const result = radio.generateRadio(candidates, 'study');
  assert.equal(result.tracks.length, 1);
  assert.equal(result.tracks[0].uri, 'piano_track');
});
