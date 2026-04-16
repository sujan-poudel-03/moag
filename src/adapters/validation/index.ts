// ─── Validation adapter registry ───

import { ValidationAdapter, ValidationTarget } from './types';
import { WebValidator } from './web-validator';
import { MobileValidator } from './mobile-validator';
import { DesktopValidator } from './desktop-validator';

export { ValidationAdapter, ValidationTarget } from './types';
export { ValidationResult, ValidationStageResult, ValidationRunOptions, validationResultToEngineResult } from './types';

const ADAPTERS: ValidationAdapter[] = [
  new WebValidator(),
  new MobileValidator(),
  new DesktopValidator(),
];

/** Get adapters for the specified targets ('all' expands to all adapters) */
export function getValidationAdapters(targets: Array<ValidationTarget | 'all'>): ValidationAdapter[] {
  if (targets.includes('all')) {
    return [...ADAPTERS];
  }
  return ADAPTERS.filter(a => targets.includes(a.target));
}

/** Get the adapter for a specific target */
export function getValidationAdapter(target: ValidationTarget): ValidationAdapter | undefined {
  return ADAPTERS.find(a => a.target === target);
}
