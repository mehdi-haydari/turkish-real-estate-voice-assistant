const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const html = fs.readFileSync(path.join(__dirname, '../services/stt/static/index.html'), 'utf8');
const names = ['normalizeSpokenText', 'inferAskedFields', 'questionTopics',
  'priorityFollowupQuestion', 'fallbackNextQuestion', 'mergeUnavailableFields',
  'mergeExtractedListingInfo', 'askQwenForNextQuestion', 'searchPortfolio'];

function runtime() {
  // Execute the application's actual functions, not a reimplementation of their rules.
  const definitions = names.map(name => {
    const start = new RegExp(`^    (?:async )?function ${name}\\(`, 'm').exec(html);
    assert.ok(start, `Missing application function ${name}`);
    const rest = html.slice(start.index + start[0].length);
    const next = /^    (?:async )?function \w+\(/m.exec(rest);
    return html.slice(start.index, start.index + start[0].length + next.index);
  }).join('\n');
  const context = vm.createContext({console});
  vm.runInContext(`
    let pendingQuestionFields=[], askedPriorityFields=new Set(), collectedListingInfo={};
    let history=[], rejectedListingNumbers=[], shown=[];
    let openingGreetingDetected=false, greetingAcknowledged=false, conversationStage='', pendingCandidate=null;
    const portfolioResultNode={}, statusNode={};
    const chatLogNode={querySelectorAll:()=>history.map(textContent=>({textContent}))};
    function showCustomerMessage(message){shown.push(message)}
    function updateCallbackSummary(){}
    ${definitions}
    globalThis.api={${names.join(',')},
      setHistory: value=>{history=value},
      setFacts: value=>{collectedListingInfo=value},
      messages:()=>shown
    };
  `, context);
  return {api: context.api, context};
}

const allFields = ['listing_number','consultant_name','transaction_type','address','location',
  'property_type','room_count','floor_number','nearby_feature'];
const preview = {candidates: [1, 2].map(floor => ({score: 40, listing: {
  listing_number: String(floor), consultant_name:'Ali', transaction_type:'kiralık',
  property_type:'daire', room_count: `${floor}+1`, floor_number: floor,
  address:'Kartal', location:'Kartal', nearby_features:['metro']
}}))};

test('Turkish consultant, room and floor questions keep their topic', () => {
  const {api} = runtime();
  for (const [question, field] of [
    ['Danışmanın adını biliyor musunuz?', 'consultant_name'],
    ['Kaç odalıydı?', 'room_count'], ['Kaçıncı kattaydı?', 'floor_number']
  ]) assert.ok(api.inferAskedFields(question).includes(field));
});

test('model-derived unknowns survive rule merging; invalid field IDs are ignored', () => {
  const {api} = runtime();
  assert.deepEqual(Array.from(api.mergeUnavailableFields(['floor_number','invented'], ['room_count'])),
    ['floor_number','room_count']);
});

test('ground floor zero replaces a previous nonzero floor and survives a later missing value', () => {
  const {api} = runtime();
  api.setFacts({floor_number: 3});
  assert.equal(api.mergeExtractedListingInfo({floor_number: 0}).floor_number, 0);
  assert.equal(api.mergeExtractedListingInfo({floor_number: null}).floor_number, 0);
});

test('all unavailable fields terminate fallback question generation', () => {
  const {api} = runtime();
  assert.equal(api.fallbackNextQuestion({discovery_channel:'afiş', unavailable_fields:allFields}, preview), null);
});

test('empty eligible options skip the second LLM call', async () => {
  const {api, context} = runtime();
  context.fetch = () => {throw new Error('No LLM call expected')};
  assert.equal(await api.askQwenForNextQuestion({discovery_channel:'afiş', unavailable_fields:allFields}, 'Bilmiyorum.', preview), null);
});

test('a model-selected forbidden field is rejected', async () => {
  const {api, context} = runtime();
  context.fetch = async () => ({ok:true, json:async()=>({choices:[{message:{content:JSON.stringify({
    field:'room_count', question:'Kaç odalıydı?'
  })}}]})});
  await assert.rejects(api.askQwenForNextQuestion({discovery_channel:'afiş', unavailable_fields:['room_count']}, '', preview),
    /izin verilmeyen/);
});

test('an eligible field and matching question are accepted', async () => {
  const {api, context} = runtime();
  context.fetch = async () => ({ok:true, json:async()=>({choices:[{message:{content:JSON.stringify({
    field:'floor_number', question:'Kaçıncı kattaydı?'
  })}}]})});
  assert.equal(await api.askQwenForNextQuestion({discovery_channel:'afiş', unavailable_fields:['room_count']}, '', preview),
    'Kaçıncı kattaydı?');
});

test('question wording must match the selected field', async () => {
  const {api, context} = runtime();
  context.fetch = async () => ({ok:true, json:async()=>({choices:[{message:{content:JSON.stringify({
    field:'floor_number', question:'Kaç odalıydı?'
  })}}]})});
  await assert.rejects(api.askQwenForNextQuestion({discovery_channel:'afiş', unavailable_fields:['room_count']}, '', preview),
    /uyuşmuyor/);
});

test('no-question outcome is not replaced by a repeated generic fallback', async () => {
  const {api, context} = runtime();
  context.fetch = async () => ({ok:true,json:async()=>({status:'ambiguous'})});
  await api.searchPortfolio({unavailable_fields:allFields, next_question:null}, preview, true);
  assert.match(api.messages().at(-1), /henüz ayırt edemedim/);
  assert.ok(!api.messages().at(-1).includes('?'));
});
