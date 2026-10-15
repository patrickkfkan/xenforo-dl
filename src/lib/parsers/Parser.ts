import { convert as htmlToText } from 'html-to-text';
import { Cheerio, CheerioAPI, Element, load as cheerioLoad } from 'cheerio';
import Logger, { LogLevel, commonLog } from '../utils/logging/Logger.js';
import { ThreadLike, ThreadMessageAttachment, ThreadPage } from '../entities/Thread.js';
import { trimNewlines } from 'trim-newlines';
import { ForumLike, ForumPage } from '../entities/Forum.js';
import URLHelper from '../utils/URLHelper.js';

export default class Parser {

  name = 'Parser';

  #logger?: Logger | null;

  constructor(logger?: Logger | null) {
    this.#logger = logger;
  }

  protected log(level: LogLevel, ...msg: any[]) {
    commonLog(this.#logger, level, this.name, ...msg);
  }

  parseThreadPage(html: string, originURL: string): ThreadPage {
    const $ = cheerioLoad(html);
    const idAttr = $('html').attr('data-content-key') || '';
    const id = idAttr.startsWith('thread-') ? Number(idAttr.substring(7)) : null;
    if (!id) {
      throw Error(`Failed to obtain thread ID from "${originURL}"`);
    }
    const siteName = $('meta[property="og:site_name"]').attr('content');
    const url = $('link[rel="canonical"]').attr('href') || '';
    const title = $('meta[property="og:title"]').attr('content') || '';

    if (!url || !title) {
      throw Error(`Failed to obtain 'url' and 'title' from "${originURL}"`);
    }

    const breadcrumbs = $('ul.p-breadcrumbs').first().find('li[itemprop="itemListElement"]').map((_i, _el) => {
      const el = $(_el);
      const crumbEl = el.find('a[itemprop="item"]');
      const href = crumbEl.attr('href');
      const title = this.#htmlToText(crumbEl.html());
      if (href && title) {
        return {
          url: new URL(href, url).toString(),
          title: _i > 0 ? title : siteName || new URL(url).host
        };
      }
      return null;
    })
      .toArray()
      .filter((v) => v !== null);

    const messages = $('article.message')
      .map((_i, _el) => {
        const el = $(_el);
        const author = el.attr('data-author');

        const idAttr = el.find('div.message-userContent').attr('data-lb-id') || '';
        const id = idAttr.startsWith('post-') ? Number(idAttr.substring(5)) : null;
        if (!id) {
          this.log('warn', 'Message skipped: failed to obtain ID.');
          return null;
        }

        const index = el.find('ul.message-attribution-opposite li').last().text().trim();

        const attachmentLinks = el
          .find('a')
          .map((_i, _el) => {
            const linkEl = $(_el);
            const href = linkEl.attr('href');
            if (href) {
              const attachmentLinkRegex = /\/attachments\/(.+)\.(\d+)/g;
              const matches = attachmentLinkRegex.exec(href);
              if (matches && !isNaN(Number(matches[2]))) {
                const imgEl = linkEl.find('img');
                const sidebarHref = linkEl.attr('data-lb-sidebar-href');
                const mediaUrl = sidebarHref ? new URL(sidebarHref.split('?')[0], url).toString() : undefined;
                return {
                  id: Number(matches[2]),
                  url: new URL(href, url).toString(),
                  filename: imgEl.attr('alt') || imgEl.attr('title'),
                  mediaUrl,
                  el: linkEl
                };
              }
            }
            return null;
          })
          .toArray()
          .filter((v) => v !== null);

        attachmentLinks.forEach((link) => link.el.remove());

        const attachments = attachmentLinks.map<ThreadMessageAttachment>((link, i) => {
          return {
            id: link.id,
            index: i,
            url: link.url,
            filename: link.filename,
            mediaUrl: link.mediaUrl
          };
        });

        const body = trimNewlines(this.#htmlToText(el.find('article.message-body').html()).trim());
        const publishedAt = el.find('ul.message-attribution-main li.u-concealed time.u-dt').attr('datetime');

        return {
          id,
          index,
          author,
          publishedAt,
          body,
          attachments
        };
      })
      .toArray()
      .filter((v) => v !== null);

    const customFields: Record<string, string> = {};
    $('dl.pairs, dl.customField').each((_i, _el) => {
      const dt = $(_el).find('dt').text().trim();
      const dd = $(_el).find('dd').text().trim();
      if (dt && dd) {
        customFields[dt] = dd;
      }
    });

    const metadata = {
      campus: customFields['Campus'] || undefined,
      semester: customFields['Học kỳ'] || customFields['Kỳ học'] || undefined,
      documentType: customFields['Loại tài liệu'] || undefined
    };

    return {
      id,
      url,
      breadcrumbs,
      title,
      messages,
      metadata,
      ...this.#parseNav($, url)
    };
  }

  parseForumPage(html: string, originURL: string): ForumPage {
    const $ = cheerioLoad(html);
    const idAttr = $('html').attr('data-content-key') || '';
    const id = idAttr.startsWith('forum-') ? Number(idAttr.substring(6)) : 0;
    
    const url = $('link[rel="canonical"]').attr('href') || originURL || '';
    const title = $('meta[property="og:title"]').attr('content') || $('title').text() || 'Forum';

    if (!url || !title) {
      throw Error(`Failed to obtain 'url' and 'title' from "${originURL}"`);
    }

    const subforums = this.#findForumLinks($('div.node--forum'), $, url);

    const threads = $('div.structItem--thread')
      .map((_i, _el) => {
        const titleEl = $(_el).find('div.structItem-title');
        const prefix = titleEl.find('span.label').text().trim() || undefined;
        
        const linkEl = titleEl.find('a').filter((i, el) => {
          const href = $(el).attr('href') || '';
          return href.includes('/threads/');
        }).first();
        
        if (!linkEl.length) {
          return null;
        }

        const href = linkEl.attr('href');
        if (href) {
          const threadLink = URLHelper.parseThreadURL(href);
          const title = this.#htmlToText(linkEl.html()).trim();
          if (threadLink?.id && title) {
            const threadURL = new URL(href, url).toString();
            return {
              title,
              prefix,
              url: threadURL.endsWith('/unread') ? threadURL.substring(0, threadURL.length - 7) : threadURL
            };
          }
        }
        return null;
      })
      .toArray()
      .reduce<ThreadLike[]>((result, t) => {
        if (t !== null && !result.find((t2) => t2.url === t.url)) {
          result.push(t);
        }
        return result;
      }, []);

    return {
      id,
      url,
      title,
      subforums,
      threads,
      ...this.#parseNav($, url)
    };
  }

  parseGenericPage(html: string, url: string) {
    const $ = cheerioLoad(html);

    const forums = this.#findForumLinks($('.node-title'), $, url);

    return {
      forums
    };
  }

  #findForumLinks(el: Cheerio<Element>, $: CheerioAPI, baseURL: string) {
    return el.find('a')
      .map((_i, _el) => {
        const linkEl = $(_el);
        const href = linkEl.attr('href');
        if (href) {
          const forumLink = URLHelper.parseForumURL(href);
          const title = this.#htmlToText(linkEl.html()).trim();
          if (forumLink && title) {
            return {
              title,
              url: new URL(href, baseURL).toString()
            };
          }
        }
        return null;
      })
      .toArray()
      .reduce<ForumLike[]>((result, f) => {
        if (f !== null && !result.find((f2) => f2.url === f.url)) {
          result.push(f);
        }
        return result;
      }, []);
  }

  #parseNav($: CheerioAPI, url: string) {
    const pageNavEl = $('div.pageNav ul.pageNav-main');
    const currentPage = this.#checkNumber(pageNavEl.find('li.pageNav-page--current a').first().text()) || 1;
    const totalPages = this.#checkNumber(pageNavEl.find('li').last().text()) || 1;
    const nextHrefEl = $('div.pageNav a.pageNav-jump--next').attr('href');
    const nextURL = nextHrefEl ? new URL(nextHrefEl, url).toString() : undefined;

    return { currentPage, totalPages, nextURL };
  }


  #checkNumber(value?: string | null) {
    if (!isNaN(Number(value))) {
      return Number(value);
    }
    return undefined;
  }

  #htmlToText(value?: string | null) {
    if (value === undefined || value === null) {
      return '';
    }
    return htmlToText(value);
  }

  parseMediaComments(html: string): { user?: string; text: string }[] {
    const $ = cheerioLoad(html);
    return $('.message--simple').map((_i, el) => {
      const user = $(el).attr('data-author');
      const text = $(el).find('.message-body').text().trim();
      return { user, text };
    }).toArray();
  }
}
