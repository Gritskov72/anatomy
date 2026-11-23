// Воркер модели ответов: движок web-llm работает здесь, страница общается с ним сообщениями
import { WebWorkerMLCEngineHandler } from '../../vendor/web-llm/web-llm.js';

const handler = new WebWorkerMLCEngineHandler();
self.onmessage = (m) => handler.onmessage(m);
