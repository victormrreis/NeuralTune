import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ExplainabilityEngine } from '../src/explainability/ExplainabilityEngine.ts';
import { PredictionResult, TrackMetadata } from '../src/types/index.ts';

test('ExplainabilityEngine: formats explanation with human-readable factors', () => {
  const engine = new ExplainabilityEngine();

  const track: TrackMetadata = {
    uri: 'track1',
    name: 'Karma Police',
    artists: [{ name: 'Radiohead', uri: 'art1' }],
    album: { name: 'OK Computer', uri: '' }
  };

  const prediction: PredictionResult = {
    track,
    score: 85,
    confidence: 0.9,
    eligible: true,
    noveltyScore: 0.15,
    reasons: [
      {
        attribute: 'genre:alternative rock',
        impact: 0.45,
        description: 'Você costuma avaliar positivamente "Gênero alternative rock"',
        source: 'Avaliações de atributos'
      },
      {
        attribute: 'tempo:moderate',
        impact: 0.25,
        description: 'Você costuma avaliar positivamente "Andamento moderado"',
        source: 'Avaliações de atributos'
      }
    ]
  };

  const formatted = engine.formatExplanation(prediction);
  assert.equal(formatted.trackName, 'Karma Police');
  assert.equal(formatted.score, 85);
  assert.equal(formatted.confidencePercent, 90);
  assert.equal(formatted.positiveFactors.length, 2);
  assert.equal(formatted.negativeFactors.length, 0);
  assert.ok(formatted.summary.includes('Fortemente alinhada'));
});
