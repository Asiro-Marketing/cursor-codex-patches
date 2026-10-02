const MODEL_ROW_RE = /([\w$]+)===2&&([\w$]+)\("div",\{className:([\w$]+)\.modelPillRow,children:\2\(([\w$]+),\{\.\.\.([\w$]+),ownRow:!0\}\)\}\)/g;
function keepModelPillInline(source) {
  const rows = [...source.matchAll(MODEL_ROW_RE)];
  if (rows.length !== 1) return { source, ok: false };
  const [row, stage, jsx, , component, props] = rows[0];
  const button = `${jsx}(${component},{...${props}})`;
  const inlineGate = `${stage}!==2&&${button}`;
  if (source.split(inlineGate).length !== 2) return { source, ok: false };
  return {
    source: source.replace(inlineGate, () => button).replace(row, () => '!1'),
    ok: true,
  };
}

export { keepModelPillInline };
