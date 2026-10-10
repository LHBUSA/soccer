// Brazilian Portuguese (pt-BR) copy for premium (Pro) API text, keyed by the API's structured codes (see
// src/i18n/pro-copy.js). Same keys as es-pro.js. Meaning is preserved exactly: descriptive comparisons only; no win
// probability, prediction or sportsbook claim is added. Numbers are inserted by the caller exactly as the API serialized them.
const RESULTS_STAGE = 'Resultados canônicos nas fases de liga/grupos da mesma competição-temporada; pontos por resultado 3/1/0.';
const LAST_TEN = 'Últimos dez placares armazenados nas fases de liga/grupos da mesma competição-temporada.';
const SEASON = 'Resultados das fases de liga/grupos da competição-temporada atual.';

export default {
  analyzer: {
    components: {
      form5: { label: 'Retrospecto recente · últimos 5', basis: RESULTS_STAGE },
      form10: { label: 'Retrospecto recente · últimos 10', basis: RESULTS_STAGE },
      scoring: { label: 'Gols marcados recentes', basis: LAST_TEN },
      conceding: { label: 'Gols sofridos recentes', basis: LAST_TEN },
      gd: { label: 'Saldo de gols recente', basis: LAST_TEN },
      season_scoring: { label: 'Gols marcados na temporada', basis: SEASON },
      season_conceding: { label: 'Gols sofridos na temporada', basis: SEASON },
      venue: { label: 'Mandante / visitante', basis: 'O mandante em casa e o visitante fora; mesmas fases de liga/grupos da competição-temporada.' },
      shots: { label: 'Criação de finalizações' },
      suppression: { label: 'Contenção de finalizações' },
      shot_diff: { label: 'Saldo de finalizações' },
      sot_diff: { label: 'Saldo de finalizações no gol' },
      rest: { label: 'Dias desde a última partida', basis: 'Dias corridos na data de referência; todas as competições. Comparação de descanso, não de condição física.' },
      load7: { label: 'Carga recente de calendário', basis: 'Partidas canônicas disputadas em sete dias, todas as competições; menos jogos = menor carga de calendário.' },
      xi: { label: 'Continuidade do time titular', basis: 'Times titulares consecutivos com fonte; fração mantida. Não é uma projeção de escalação.' },
    },
    metrics: { shots: 'finalizações', shots_on_target: 'finalizações no gol' },
    // `has` = the API named a compatible stat basis; its provider signature is never displayed (DATA · PropSports).
    shotBasis: (metric, has) => has ? `${metric[0].toUpperCase()}${metric.slice(1)} pareadas time/adversário de uma única base estatística compatível (DATA · PropSports).` : `${metric[0].toUpperCase()}${metric.slice(1)} pareadas time/adversário; sem base estatística compatível.`,
    units: { 'pts/m': 'pts/j', 'goals/m': 'gols/j', 'shots/m': 'finalizações/j', days: 'dias', matches: 'partidas', fraction: 'fração' },
    explanation: ({ home, away, unit, hs, as, basis }) => `Mandante: ${home} ${unit}; visitante: ${away} ${unit}. Amostras: ${hs} / ${as}. ${basis}`,
    omittedReason: 'Cobertura pareada ausente, incompatível ou insuficiente.',
    normalization: 'clamp((mandante - visitante) / escala, -1, 1), invertido quando menor é melhor',
    coverageLabels: ['DADOS INSUFICIENTES · AVALIAÇÃO RETIDA', 'RESULTADOS + ESTATÍSTICAS COMPATÍVEIS', 'SOMENTE RESULTADOS / CALENDÁRIO'],
    coverageBasis: 'Cobertura de observações armazenadas, nunca confiança preditiva. Resultados de seleções nunca entram nas amostras de comparação de ligas de clubes.',
    historyBasis: 'Gols canônicos de fase de liga/grupos ponderados por partida em temporadas armazenadas; métricas de eventos/estatísticas não são comparadas entre épocas.',
    ratingLabel: 'AVALIAÇÃO DE CONFRONTO PBE: pontuação descritiva por componentes. Não é uma probabilidade de vitória nem uma previsão.',
    formula: 'Resultados 50%, estatísticas de finalização compatíveis 30%, calendário/time titular 20%; pesos iguais dentro de cada grupo disponível, grupos renormalizados quando ausentes. Mandante = round(50 + 50 × vantagem ponderada), visitante = round(50 - 50 × vantagem ponderada). As escalas são normalizações de exibição, não pesos preditivos ajustados. A avaliação exige ao menos três partidas com resultado por time.',
  },
  // Competition product names (src/lib/competitions.js `name`): only names with an established Brazilian form.
  competitions: {
    'FIFA World Cup': 'Copa do Mundo da FIFA',
    'European Championship': 'Eurocopa',
    "Women's Champions League": 'Champions League Feminina',
  },
  index: {
    congestion_14: { label: 'Partidas nos últimos 14 dias', detail: [n => `${n} em 14 dias (5 = carga máxima)`] },
    short_rest: { label: 'Partidas com pouco descanso (< 4 dias) em 21 dias', detail: [n => `${n} partida(s) com pouco descanso`] },
    rest: { label: 'Descanso antes da próxima partida (ou desde a última)', detail: [n => `${n} dia(s)`, () => 'sem partida recente'] },
    travel_sequence: { label: 'Proporção de jogos fora nas últimas cinco', detail: [() => 'nenhum'] },
    competition_switching: { label: 'Trocas de competição nas últimas cinco', detail: [n => `${n} troca(s)`] },
    xi_minutes_share_14: { label: 'Proporção dos minutos disponíveis jogados pelo último time titular (14 dias)', detail: [(p, cap) => `${p}% de ${cap} minutos de time por jogador`] },
    international_return: { label: 'Jogadores do último time titular voltando da seleção', detail: [n => `${n} jogador(es)`] },
    schedule: { label: 'Índice de desgaste do time (calendário)', detail: [n => `${n}/100`] },
    concentration: { label: 'Minutos concentrados nos 11 principais', detail: [p => `${p}% dos minutos`, () => 'sem escalações com fonte'] },
    continuity: { label: 'Continuidade do time titular', detail: [p => `${p}% dos titulares mantidos`, () => 'menos de duas escalações com fonte'] },
  },
  // Renderer copy with values (src/components/analyzer.js). Keys mirror the English UI_EN there.
  ui: {
    level: 'EQUILIBRADO',
    edgeMeta: ({ edge, sh, sa, ch, th, ca, ta }) => `VANTAGEM ${edge} / 1 · AMOSTRA ${sh} / ${sa} · COBERTURA ${ch}/${th} mandante, ${ca}/${ta} visitante`,
    axis: edge => `Vantagem normalizada do mandante ${edge} em uma escala de menos um a um`,
    scaleWeight: ({ norm, scale, weight }) => `${norm}. Escala: ${scale}. Peso: ${weight}% dos componentes disponíveis.`,
    groups: { results: 'RESULTADOS E RETROSPECTO', style: 'ESTILO / DADOS DE FINALIZAÇÃO', schedule: 'CALENDÁRIO E TIME TITULAR' },
    note: ({ comp, season, asOf }) => `Comparações descritivas pré-jogo · ${comp} ${season} · na data de ${asOf}. Sem probabilidade de vitória nem previsão.`,
    previewNote: ({ comp, season, asOf }) => `Comparações canônicas descritivas · ${comp} ${season} · na data de ${asOf}. Sem previsão nem probabilidade de vitória.`,
    componentScore: 'Pontuação por componentes / 100',
    baseline: ({ seasons, window, matches }) => `${seasons} temporadas armazenadas na janela das últimas ${window} temporadas disponíveis · ${matches} partidas de referência`,
    scoring: ({ cur, base, change }) => [`Gols marcados: `, cur, ` atual / ${base} referência · variação ${change}`],
    conceding: ({ cur, base, change }) => [`Gols sofridos: `, cur, ` atual / ${base} referência · variação ${change}`],
    currentMatches: n => `${n} partidas atuais.`,
    noBaseline: 'Não há uma referência compatível de temporada anterior armazenada.',
    h2h: ({ n, home, hg, away, ag }) => `${n} confrontos armazenados · ${home} ${hg} gols / ${away} ${ag} gols`,
    noH2h: 'Menos de dois confrontos canônicos armazenados. Sem resumo de confronto direto.',
    coverageRows: ['Partidas com resultado', 'Escalações com fonte (janela de carga de 21 dias)', 'Partidas com estatísticas de finalização pareadas', 'Partidas com registro de eventos', 'Competições-temporadas armazenadas', 'Proporção de minutos nominais dos 11 principais'],
    omitted: n => `${n} componentes indisponíveis omitidos`,
    minimum: n => `Amostra mínima: ${n}`,
    sample: (h, a) => `AMOSTRA ${h} / ${a}`,
    edge: e => `VANTAGEM ${e}`,
    tooFew: 'Há poucos dados canônicos compatíveis para uma comparação. Nenhum valor é preenchido.',
    previewCoverage: l => `COBERTURA DE DADOS · ${l}. É cobertura de amostra, não confiança preditiva.`,
    limited: 'LIMITADA',
  },
};
