import { Thread } from '../entities/Thread.js';

const THREAD_HEADER_TEMPLATE =
`===============================================================================
{thread.title}
{thread.url}
===============================================================================

`;

export default class ThreadHeaderTemplate {

  static format(thread: Thread) {
    let template = THREAD_HEADER_TEMPLATE
      .replaceAll('{thread.title}', thread.title)
      .replaceAll('{thread.url}', thread.url);

    if (thread.metadata && (thread.metadata.campus || thread.metadata.semester || thread.metadata.documentType)) {
      let metadataStr = '';
      if (thread.metadata.campus) metadataStr += `Campus: ${thread.metadata.campus}\n`;
      if (thread.metadata.semester) metadataStr += `Kỳ học: ${thread.metadata.semester}\n`;
      if (thread.metadata.documentType) metadataStr += `Loại tài liệu: ${thread.metadata.documentType}\n`;
      
      template += `Metadata:\n${metadataStr}\n===============================================================================\n\n`;
    }

    return template;
  }
}
