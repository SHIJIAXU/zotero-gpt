
import PDF from "E:/Github/zotero-reference/src/modules/pdf"
import { config } from "../../package.json";
import { MD5 } from "crypto-js"
import { PineconeClient } from "@pinecone-database/pinecone";
import { Document } from "langchain/document";
import { OpenAIEmbeddings } from "langchain/embeddings/openai";
import { PineconeStore } from "langchain/vectorstores/pinecone";

export default class Utils {
  private cache: any = {}
  constructor() {
  }

  /**
   * 获取PDF页面文字
   * @returns 
   */
  public getPDFSelection() {
    try {
      return ztoolkit.Reader.getSelectedText(
        Zotero.Reader.getByTabID(Zotero_Tabs.selectedID)
      );
    } catch {
      return ""
    }
  }

  /**
   * 获取选中条目某个字段
   * @param fieldName 
   * @returns 
   */
  public getItemField(fieldName: any) {
    return ZoteroPane.getSelectedItems()[0].getField(fieldName)
  }

  /**
   * 如果当前在主面板，根据选中条目生成文本，查找相关 - 用于搜索条目
   * 如果在PDF阅读界面，阅读PDF原文，查找返回相应段落 - 用于总结问题
   * @param host 
   * @param queryText 
   * @returns 
   */
  public async getRelatedText(host: string, queryText: string) {
    // 由于处理后的文本会被优化，需要一个函数与cache里做匹配
    // 有一定概率匹配不上
    function findMostOverlap(text: string, textArr: string[]): number {
      let maxOverlapIndex = -1;
      let maxOverlap = 0;

      const textSentences = text.split(/[.!?]/).filter(Boolean);

      for (let i = 0; i < textArr.length; i++) {
        const textArrSentences = textArr[i].split(/[.!?]/).filter(Boolean);

        let overlapCount = 0;
        for (let j = 0; j < textSentences.length; j++) {
          if (textArrSentences.map(i => i.replace(/\x20+/g, "")).includes(textSentences[j].replace(/\x20+/g, ""))) {
            overlapCount++;
          }
        }

        if (overlapCount > maxOverlap) {
          maxOverlap = overlapCount;
          maxOverlapIndex = i;
        }
      }

      return maxOverlapIndex;
    }
    let fullText: string, key: string
    switch (Zotero_Tabs.selectedIndex) {
      case 0:
        // 只有再次选中相同条目，且条目没有更新变化，才会复用，不然会一直重复建立索引
        // TODO - 优化
        key = MD5(ZoteroPane.getSelectedItems().map(i => i.key).join("")).toString()
        fullText = await this.selectedItems2FullText(key)
        break;
      default:
        let pdfItem = Zotero.Items.get(
          Zotero.Reader.getByTabID(Zotero_Tabs.selectedID)!.itemID as number
        )
        key = pdfItem.key
        fullText = await this.readPDFFullText(key, key in this.cache == false)
        break
    }
    const xhr = await Zotero.HTTP.request(
      "POST",
      `http://${host}/getRelatedText`,
      {
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          queryText,
          fullText,
          key,
          secretKey: Zotero.Prefs.get(`${config.addonRef}.secretKey`) as string,
          api: Zotero.Prefs.get(`${config.addonRef}.api`) as string,
        }),
        responseType: "json"
      }
    );
    let text = ""
    let references: any[] = []
    for (let i = 0; i < xhr.response.length; i++) {
      let refText = xhr.response[i]
      // 寻找坐标
      let index = findMostOverlap(refText.replace(/\x20+/g, " "), this.cache[key].map((i: any) => i.text.replace(/\x20+/g, " ")))
      if (index >= 0) {
        references.push({
          number: i + 1,
          location: this.cache[key][index].location,
          text: refText
        })
      }
      text += `[${i + 1}] ${refText}`
      if (i < xhr.response.length - 1) {
        text += "\n\n"
      }  
    }
    const outputContainer = Zotero[config.addonInstance].views.outputContainer
    outputContainer.querySelector(".reference")?.remove()
    const refDiv = ztoolkit.UI.appendElement({
      namespace: "html",
      classList: ["reference"],
      tag: "div",
      styles: {
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
      }
    }, outputContainer)
    console.log(references)
    references.forEach((reference: { number: number; location: { type: "box" | "id", box?: any, id?: number}, text: string }) => {
      if (!reference.location) { return }
      ztoolkit.UI.appendElement({
        namespace: "html",
        tag: "a",
        styles: {
          margin: ".3em",
          fontSize: "0.8em",
          color: "rgba(89, 192, 188, 1)",
          cursor: "pointer"
        },
        properties: {
          innerText: `[${reference.number}]`
        },
        listeners: [ 
          {
            type: "click",
            listener: async () => {
              console.log(reference)
              if (reference.location.type == "box") {
                const reader = await ztoolkit.Reader.getReader();
                (reader!._iframeWindow as any).wrappedJSObject.eval(`
                  PDFViewerApplication.pdfViewer.scrollPageIntoView({
                    pageNumber: ${reference.location.box.page + 1},
                    destArray: ${JSON.stringify([null, { name: "XYZ" }, reference.location.box.left, reference.location.box.top, 3.5])},
                    allowNegativeOffset: false,
                    ignoreDestinationZoom: false
                  })
                `)
              } else if (reference.location.type == "id") {
                await ZoteroPane.selectItem(reference.location.id as number)
              }
            }
          }
        ]
      }, refDiv)
    })
    return text
  }

  /**
   * await Zotero.ZoteroGPT.utils.readPDFFullText()
   */
  public async readPDFFullText(itemkey: string, force: boolean = false) {
    // @ts-ignore
    const OS = window.OS;
    const temp = Zotero.getTempDirectory()
    const filename = OS.Path.join(temp.path.replace(temp.leafName, ""), `${config.addonRef}-${itemkey}.json`);
    if (!force && await OS.File.exists(filename)) {
      return await Zotero.File.getContentsAsync(filename) as string
    }
    const reader = await ztoolkit.Reader.getReader() as _ZoteroTypes.ReaderInstance
    const PDFViewerApplication = (reader._iframeWindow as any).wrappedJSObject.PDFViewerApplication;
    await PDFViewerApplication.pdfLoadingTask.promise;
    await PDFViewerApplication.pdfViewer.pagesPromise;
    let pages = PDFViewerApplication.pdfViewer._pages;
    const PDFInstance = new PDF()
    let totalPageNum = pages.length
    const popupWin = new ztoolkit.ProgressWindow("[Pending] PDF", {closeTime: -1})
      .createLine({ text: `[1/${totalPageNum}] Reading`, progress: 1, type: "success"})
      .show()
    // 读取所有页面lines
    const pageLines: any = {}
    for (let pageNum = 0; pageNum < totalPageNum; pageNum++) {
      let pdfPage = pages[pageNum].pdfPage
      let textContent = await pdfPage.getTextContent()
      let items: PDFItem[] = textContent.items.filter((item: PDFItem) => item.str.trim().length)
      let lines = PDFInstance.mergeSameLine(items)
      let index = lines.findIndex(line => /(r?eferences?|acknowledgements)$/i.test(line.text.trim()))
      if (index != -1) {
        lines = lines.slice(0, index)
      }
      pageLines[pageNum] = lines
      popupWin.changeLine({ text: `[${pageNum+1}/${totalPageNum}] Reading`, progress: (pageNum+1) / totalPageNum * 100 })
      if (index != -1) {
        break
      }
    }
    console.log(pageLines)
    popupWin.changeHeadline("[Pending] PDF");
    popupWin.changeLine({ progress: 100 });
    let pdfText = ""
    totalPageNum = Object.keys(pageLines).length
    let _paragraphs: any[] | undefined
    for (let pageNum = 0; pageNum < totalPageNum; pageNum++) {
      let pdfPage = pages[pageNum].pdfPage
      const maxWidth = pdfPage._pageInfo.view[2];
      const maxHeight = pdfPage._pageInfo.view[3];
      let lines = [...pageLines[pageNum]]
      // 去除页眉页脚信息
      let removeLines = new Set()
      let removeNumber = (text: string) => {
        // 英文页码
        if (/^[A-Z]{1,3}$/.test(text)) {
          text = ""
        }
        // 正常页码1,2,3
        text = text.replace(/\x20+/g, "").replace(/\d+/g, "")
        return text
      }
      // 是否跨页同位置
      let isIntersectLines = (lineA: any, lineB: any) => {
        let rectA = {
          left: lineA.x / maxWidth,
          right: (lineA.x + lineA.width) / maxWidth,
          bottom: lineA.y / maxHeight,
          top: (lineA.y + lineA.height) / maxHeight
        }
        let rectB = {
          left: lineB.x / maxWidth,
          right: (lineB.x + lineB.width) / maxWidth,
          bottom: lineB.y / maxHeight,
          top: (lineB.y + lineB.height) / maxHeight
        }
        return PDFInstance.isIntersect(rectA, rectB)
      }
      // 是否为重复
      let isRepeat = (line: PDFLine, _line: PDFLine) => {
        let text = removeNumber(line.text)
        let _text = removeNumber(_line.text)
        return text == _text && isIntersectLines(line, _line)
      }
      // 存在于数据起始结尾的无效行
      for (let i of Object.keys(pageLines)) {
        if (Number(i) == pageNum) { continue }
        // 两个不同页，开始对比
        let _lines = pageLines[i]
        let directions = {
          forward: {
            factor: 1,
            done: false
          },
          backward: {
            factor: -1,
            done: false
          }
        }
        for (let offset = 0; offset < lines.length && offset < _lines.length; offset++) {
          ["forward", "backward"].forEach((direction: string) => {
            if (directions[direction as keyof typeof directions].done) { return }
            let factor = directions[direction as keyof typeof directions].factor
            let index = factor * offset + (factor > 0 ? 0 : -1)
            let line = lines.slice(index)[0]
            let _line = _lines.slice(index)[0]
            if (isRepeat(line, _line)) {
              // 认为是相同的
              line[direction] = true
              removeLines.add(line)
            } else {
              directions[direction as keyof typeof directions].done = true
            }
          })
        }
        // 内部的
        // 设定一个百分百正文区域防止误杀
        const content = { x: 0.2 * maxWidth, width: .6 * maxWidth, y: .2 * maxHeight, height: .6 * maxHeight }
        for (let j = 0; j < lines.length; j++) {
          let line = lines[j]
          if (isIntersectLines(content, line)) { continue }
          for (let k = 0; k < _lines.length; k++) {
            let _line = _lines[k]
            if (isRepeat(line, _line)) {
              line.repeat = line.repeat == undefined ? 1 : (line.repeat + 1)
              line.repateWith = _line
              removeLines.add(line)
            }
          }
        }  
      }
      lines = lines.filter((e: any) => !(e.forward || e.backward || (e.repeat && e.repeat > 3)));
      // 段落聚类
      // 原则：字体从大到小，合并；从小变大，断开
      let abs = (x: number) => x > 0 ? x: -x
      const paragraphs = [[lines[0]]]
      for (let i = 1; i < lines.length; i++) {
        let lastLine = paragraphs.slice(-1)[0].slice(-1)[0]
        let currentLine = lines[i]
        let nextLine = lines[i+1]
        const isNewParagraph = 
          // 达到一定行数阈值
          paragraphs.slice(-1)[0].length >= 3 && (
          // 当前行存在一个非常大的字体的文字
          currentLine._height.some((h2: number) => lastLine._height.every((h1: number) => h2 > h1)) ||
          // 是摘要自动为一段
          /abstract/i.test(currentLine.text) ||
          // 与上一行间距过大
          abs(lastLine.y - currentLine.y) > currentLine.height * 2 ||
          // 首行缩进分段
            (currentLine.x > lastLine.x && nextLine && nextLine.x < currentLine.x)
          )
        // 开新段落
        if (isNewParagraph) {
          paragraphs.push([currentLine])
        }
        // 否则纳入当前段落
        else {
          paragraphs.slice(-1)[0].push(currentLine)
        }
      }
      console.log(paragraphs)
      // 段落合并
      let pageText = ""
      for (let i = 0; i < paragraphs.length; i++) {
        let box: { page: number, left: number; top: number; right: number; bottom: number }
        /**
         * 所有line是属于一个段落的
         * 合并同时计算它的边界
         */
        let _pageText = ""
        let line, nextLine
        for (let j = 0; j < paragraphs[i].length;j++) {
          line = paragraphs[i][j]
          nextLine = paragraphs[i]?.[j+1]
          // 更新边界
          box ??= { page: pageNum, left: line.x, right: line.x + line.width, top: line.y + line.height, bottom: line.y }
          if (line.x < box.left) {
            box.left = line.x
          }
          if (line.x + line.width > box.right) {
            box.right = line.x + line.width
          }
          if (line.y < box.bottom) {
            line.y = box.bottom
          }
          if (line.y + line.height > box.top) {
            box.top = line.y + line.height
          }
          _pageText += line.text
          if (
            nextLine &&
            line.height > nextLine.height
          ) {
            _pageText = "\n"
          } else if (j < paragraphs[i].length - 1) {
            if (!line.text.endsWith("-")) {
              _pageText += " "
            }
          }
        }
        _pageText = _pageText.replace(/\x20+/g, " ");
        (this.cache[itemkey] ??= []).push({
          location: {type: "box", box: box!},
          text: _pageText
        })
        pageText += _pageText
        if (i < paragraphs.length - 1) {
          pageText += "\n\n"
        }
      }
      /**
       * _paragraphs为上一页的paragraphs
       */
      if (_paragraphs && !(
        // 两页首尾字体大小一致
        _paragraphs.slice(-1)[0].slice(-1)[0].height == paragraphs[0][0].height &&
        // 开头页没有首行缩进
        paragraphs[0][0].x == paragraphs[0][1]?.x
      )) {
        pdfText += "\n\n"
      } else {
        pdfText += " "
      }
      pdfText += pageText
      _paragraphs = paragraphs
    }
    popupWin.changeHeadline("[Done] PDF")
    popupWin.startCloseTimer(1000)
    const fullText = pdfText.replace(/\x20+/g, " ")
    await Zotero.File.putContentsAsync(filename, fullText);
    console.log(fullText)
    return fullText
  }

  /**
   * 将选中条目处理成全文
   * @param key 
   * @param force 
   * @returns 
   */
  public async selectedItems2FullText(key: string) {
    const fullText = ZoteroPane.getSelectedItems().map((item: Zotero.Item) => {
      const text = JSON.stringify(item.toJSON());
      (this.cache[key] ??= []).push({
        location: {
          type: "id",
          id: item.id
        },
        text: text.slice(0, 500)
      })
      return text
    }).join("\n\n")
    return fullText
  }

  /**
   * 获取剪贴板文本
   * @returns 
   */
  public getClipboardText() {
    // @ts-ignore
    const clipboardService = window.Cc['@mozilla.org/widget/clipboard;1'].getService(Ci.nsIClipboard);
    // @ts-ignore
    const transferable = window.Cc['@mozilla.org/widget/transferable;1'].createInstance(Ci.nsITransferable);
    if (!transferable) {
      window.alert('剪贴板服务错误：无法创建可传输的实例');
    }
    transferable.addDataFlavor('text/unicode');
    clipboardService.getData(transferable, clipboardService.kGlobalClipboard);
    let clipboardData = {};
    let clipboardLength = {};
    try {
      transferable.getTransferData('text/unicode', clipboardData, clipboardLength);
    } catch (err: any) {
      console.error('剪贴板服务获取失败：', err.message);
    }
    // @ts-ignore
    clipboardData = clipboardData.value.QueryInterface(Ci.nsISupportsString);
    // @ts-ignore
    return clipboardData.data
  }

  private async similaritySearch(paragraphs: string[]) {
    const client = new PineconeClient();
    await client.init({
      apiKey: "993aaaa3-6d08-4809-869f-1b6f11aa1b9b",
      environment: "asia-southeast1-gcp",
    });
    const pineconeIndex = client.Index("polygon"); 
    for (let paragraph of paragraphs) {
      
    }
    const docs = [
      new Document({
        metadata: { foo: "bar" },
        pageContent: "pinecone is a vector db",
      }),
      new Document({
        metadata: { foo: "bar" },
        pageContent: "the quick brown fox jumped over the lazy dog",
      }),
      new Document({
        metadata: { baz: "qux" },
        pageContent: "lorem ipsum dolor sit amet",
      }),
      new Document({
        metadata: { baz: "qux" },
        pageContent: "pinecones are the woody fruiting body and of a pine tree",
      }),
    ];
    const embeddings = new OpenAIEmbeddings({
      timeout: 1000, // 1s timeout
    }, {
      basePath: "https://www.openread.academy/personal-api/uc/openapi/v1"
      // basePath: "https://openai.api2d.net/v1",
      // apiKey: "fk193146-yRZiddVj2s84RwpJOSsE0lGLuHQ8uK6Q"
    });
    const vectorStore = await PineconeStore.fromDocuments(docs, embeddings, {
      pineconeIndex,
    });

    const results = await vectorStore.similaritySearch("pinecone", 3, {
      foo: "bar",
    });
    console.log("results", results);
  }
}