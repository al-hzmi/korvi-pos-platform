import { describe, expect, it } from 'vitest';
import { nextPreparationTaskStatus, preparationTaskActionLabel } from '../kds';

describe('KDS task lifecycle', () => {
  it('permits only the forward operational lifecycle', () => {
    expect(nextPreparationTaskStatus('queued')).toBe('preparing');
    expect(nextPreparationTaskStatus('preparing')).toBe('ready');
    expect(nextPreparationTaskStatus('ready')).toBe('served');
    expect(nextPreparationTaskStatus('served')).toBeNull();
  });

  it('keeps operator actions aligned with lifecycle state', () => {
    expect(preparationTaskActionLabel('queued')).toBe('بدء التحضير');
    expect(preparationTaskActionLabel('preparing')).toBe('جاهز');
    expect(preparationTaskActionLabel('ready')).toBe('تم التقديم');
    expect(preparationTaskActionLabel('served')).toBeNull();
  });
});
