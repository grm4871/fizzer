import React, { ReactNode } from 'react';

/**
 * Tokenizes a JSON string and renders styled spans for key tokens.
 */
export function highlightJSON(jsonStr: string): ReactNode[] {
  const tokenRegex = /("(?:\\u[a-fA-F0-9]{4}|\\[^u]|[^\\"])*")|(-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)|(true|false)|(null)|([{}[\]:,])|(\s+)/g;
  const tokens: { text: string; type: string }[] = [];
  let lastIdx = 0;
  let m: RegExpExecArray | null;

  while ((m = tokenRegex.exec(jsonStr)) !== null) {
    if (m.index > lastIdx) {
      tokens.push({ text: jsonStr.slice(lastIdx, m.index), type: 'plain' });
    }
    const [
      ,
      strToken,
      numToken,
      boolToken,
      nullToken,
      puncToken,
      wsToken
    ] = m;
    if (strToken !== undefined) tokens.push({ text: strToken, type: 'string' });
    else if (numToken !== undefined) tokens.push({ text: numToken, type: 'number' });
    else if (boolToken !== undefined) tokens.push({ text: boolToken, type: 'boolean' });
    else if (nullToken !== undefined) tokens.push({ text: nullToken, type: 'null' });
    else if (puncToken !== undefined) tokens.push({ text: puncToken, type: 'punctuation' });
    else if (wsToken !== undefined) tokens.push({ text: wsToken, type: 'whitespace' });
    
    lastIdx = tokenRegex.lastIndex;
  }
  if (lastIdx < jsonStr.length) {
    tokens.push({ text: jsonStr.slice(lastIdx), type: 'plain' });
  }

  // Identify keys: a string token followed by optional whitespace and a colon is a key
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t.type === 'string') {
      let isKey = false;
      for (let j = i + 1; j < tokens.length; j++) {
        if (tokens[j].type === 'whitespace') continue;
        if (tokens[j].type === 'punctuation' && tokens[j].text === ':') {
          isKey = true;
        }
        break;
      }
      if (isKey) {
        t.type = 'key';
      }
    }
  }

  return tokens.map((t, idx) => {
    if (t.type === 'key') return <span key={idx} className="json-token-key">{t.text}</span>;
    if (t.type === 'string') return <span key={idx} className="json-token-string">{t.text}</span>;
    if (t.type === 'number') return <span key={idx} className="json-token-number">{t.text}</span>;
    if (t.type === 'boolean') return <span key={idx} className="json-token-boolean">{t.text}</span>;
    if (t.type === 'null') return <span key={idx} className="json-token-null">{t.text}</span>;
    if (t.type === 'punctuation') return <span key={idx} className="json-token-punctuation">{t.text}</span>;
    return t.text;
  });
}
