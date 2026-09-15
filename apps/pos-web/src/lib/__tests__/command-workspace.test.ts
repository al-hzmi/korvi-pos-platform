import { describe, expect, it } from 'vitest';
import { commandFailureReleasesWorkspace } from '../command-workspace';

describe('command workspace release policy', () => {
  it.each(['edit-command', 'permission', 'reauthenticate'])(
    'releases the global workspace after definitive refusal %s',
    (action) => expect(commandFailureReleasesWorkspace(action)).toBe(true),
  );

  it.each(['retry-same', 'refresh-stock', 'refresh-cost', 'refresh-purchasing', 'blocking'])(
    'keeps the workspace frozen when outcome/reconciliation still requires protection: %s',
    (action) => expect(commandFailureReleasesWorkspace(action)).toBe(false),
  );
});
