import test from 'node:test';import assert from 'node:assert/strict';
import {punctuateAnswer} from '../src/interviewPunctuation.mjs';
import {reviewReadiness,answerCharacters} from '../server/interview-readiness.mjs';
test('复盘只需一题，不用答得好；标点不能凑字数',()=>{
 assert.equal(reviewReadiness([{question:'怎么处理？',answer:'我确实不知道'}]).ready,true);
 assert.equal(reviewReadiness([]).ready,false);
 assert.equal(reviewReadiness([{question:'怎么处理？',answer:'。。。，，'}]).ready,false);
 assert.equal(answerCharacters(' 我，不。知！道？ '),4);
 assert.match(reviewReadiness([{question:'怎么处理？',answer:'不会。'}]).message,/内容太少/);
});
test('本机标点保留数字、术语与全部原话，按停顿断句并可重复使用',()=>{
 const text='我负责API 2.5的需求分析然后确认交付时间';
 const words=[{text:'我负责API 2.5的需求分析',start:0,end:3,startChar:0,endChar:15},{text:'然后确认交付时间',start:4,end:6,startChar:15,endChar:text.length}];
 // Derive exact offsets so punctuation never relies on guessed alignment.
 const split=text.indexOf('然后');words[0].endChar=split;words[1].startChar=split;
 const result=punctuateAnswer(text,words);
 assert.equal(result,'我负责API 2.5的需求分析。然后确认交付时间。');
 assert.equal(punctuateAnswer(result),result);
 assert.equal(result.replace(/[，；。]/g,''),text);
 assert.equal(punctuateAnswer('Use https://example.com/v1 and API 2.5.'),'Use https://example.com/v1 and API 2.5.');
});
test('无时间戳的旧回答可补枚举标点，不会改写识别错误',()=>{
 const text='第一个是意图识别第二个是工具调用第三个是工具链路检测第四个是整体恢复';
 const result=punctuateAnswer(text);
 assert.equal(result,'第一个是意图识别；第二个是工具调用；第三个是工具链路检测；第四个是整体恢复。');
 assert.equal(result.replace(/[，；。]/g,''),text);
 const existing='首先，我做了需求分析。然后，我核对了 query 的结果。';
 assert.equal(punctuateAnswer(existing),existing);
});
