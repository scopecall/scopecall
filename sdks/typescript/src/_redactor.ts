// PII redactor — patterns mirror schemas/redaction/patterns.yaml.
// Bundled at build time. Zero runtime file I/O.
// Order matches patterns.yaml: EMAIL → CARD → SSN → IP → PHONE (to avoid partial matches).

interface Pattern {
  name: string;
  regex: RegExp;
  replacement: string;
  luhnCheck: boolean;
}

function luhnCheck(digits: string): boolean {
  const nums = digits.replace(/\D/g, "").split("").map(Number);
  let sum = 0;
  let double = false;
  for (let i = nums.length - 1; i >= 0; i--) {
    let d = nums[i];
    if (double) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    double = !double;
  }
  return sum % 10 === 0;
}

const DEFAULT_PATTERNS: Pattern[] = [
  {
    name: "EMAIL",
    regex: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g,
    replacement: "[EMAIL]",
    luhnCheck: false,
  },
  {
    name: "CARD",
    regex: /\b(?:\d{4}[-\s]?){3}\d{4}\b/g,
    replacement: "[CARD]",
    luhnCheck: true,
  },
  {
    name: "SSN",
    regex: /\b\d{3}-\d{2}-\d{4}\b/g,
    replacement: "[SSN]",
    luhnCheck: false,
  },
  {
    name: "IP",
    regex: /\b(?:\d{1,3}\.){3}\d{1,3}\b/g,
    replacement: "[IP]",
    luhnCheck: false,
  },
  {
    name: "PHONE",
    regex: /\b(?:\+?1[-.\s]?)?\(?\d{3}\)?[-.\s]\d{3}[-.\s]\d{4}\b/g,
    replacement: "[PHONE]",
    luhnCheck: false,
  },
];

export interface AdditionalPattern {
  name: string;
  regex: string;
}

export class Redactor {
  private readonly patterns: Pattern[];

  constructor(additional: AdditionalPattern[] = []) {
    const extra: Pattern[] = additional.map((p) => ({
      name: p.name,
      regex: new RegExp(p.regex, "g"),
      replacement: `[${p.name.toUpperCase()}]`,
      luhnCheck: false,
    }));
    this.patterns = [...DEFAULT_PATTERNS, ...extra];
  }

  redact(text: string): string {
    let result = text;
    for (const pattern of this.patterns) {
      // Reset lastIndex for global regexes between calls
      pattern.regex.lastIndex = 0;
      if (pattern.luhnCheck) {
        result = result.replace(pattern.regex, (match) => {
          return luhnCheck(match) ? pattern.replacement : match;
        });
      } else {
        result = result.replace(pattern.regex, pattern.replacement);
      }
    }
    return result;
  }
}

/** Module-level default redactor (no additional patterns) */
const _defaultRedactor = new Redactor();

export function redact(text: string): string {
  return _defaultRedactor.redact(text);
}
