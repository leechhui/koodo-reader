import {
  ConfigService,
  TokenService,
} from "../../assets/lib/kookit-extra-browser.min";
import { isElectron } from "react-device-detect";
import localforage from "localforage";
import BookModel from "../../models/Book";
import toast from "react-hot-toast";
import { getStorageLocation, showDownloadProgress } from "../common";
import { Buffer } from "buffer";
import SyncService from "../storage/syncService";
import { CommonTool } from "../../assets/lib/kookit-extra-browser.min";
import DatabaseService from "../storage/databaseService";
import Book from "../../models/Book";
import i18n from "../../i18n";
import { getCloudConfig } from "./common";
import CoverUtil from "./coverUtil";
import { LocalFileManager } from "./localFile";
import {
  decryptBookPayload,
  encryptBookPayload,
  getEncryptedBookFileName,
  getPlainBookFileName,
  isEncryptedMarkedFileName,
  removeEncryptedMarkerFromFileName,
} from "./bookCrypto";
declare var window: any;

const bufferToArrayBuffer = (buffer: Buffer): ArrayBuffer => {
  return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
};

const getFileNameFromPath = (bookPath: string): string => {
  if (!bookPath) return "";
  const normalized = bookPath.replace(/\\/g, "/");
  return normalized.split("/").pop() || "";
};

class BookUtil {
  static async addBook(key: string, format: string, buffer: ArrayBuffer) {
    // for both original books and cached boks
    if (ConfigService.getItem("defaultSyncOption")) {
      toast.loading(i18n.t("Uploading book"), {
        id: "add-book",
      });
    }
    if (isElectron) {
      const fs = window.require("fs");
      const path = window.require("path");
      const dataPath = getStorageLocation() || "";
      try {
        if (!fs.existsSync(path.join(dataPath, "book"))) {
          fs.mkdirSync(path.join(dataPath, "book"), { recursive: true });
        }
        fs.writeFileSync(
          path.join(dataPath, "book", key + "." + format),
          Buffer.from(buffer)
        );
        await this.uploadBook(key, format);
      } catch (error) {
        const errorMessage =
          error instanceof Error ? error.message : String(error);
        toast.error(errorMessage);
        throw error;
      }
    } else {
      if (ConfigService.getItem("isUseLocal") === "yes") {
        await LocalFileManager.saveFile(key + "." + format, buffer, "book");
      } else {
        await localforage.setItem(key, buffer);
      }
      await this.uploadBook(key, format);
    }
  }
  static deleteBook(key: string, format: string) {
    try {
      if (isElectron) {
        const fs_extra = window.require("fs-extra");
        const path = window.require("path");
        const dataPath = getStorageLocation() || "";
        return new Promise<void>((resolve, reject) => {
          try {
            const plainFilePath = path.join(
              dataPath,
              `book`,
              getPlainBookFileName(key, format)
            );
            const encryptedFilePath = path.join(
              dataPath,
              `book`,
              getEncryptedBookFileName(key, format)
            );

            fs_extra.remove(plainFilePath, () => {
              fs_extra.remove(encryptedFilePath, () => {
                this.deleteCloudBook(key, format);
                resolve();
              });
            });
          } catch (e) {
            reject();
          }
        });
      } else {
        this.deleteCloudBook(key, format);
        if (ConfigService.getItem("isUseLocal") === "yes") {
          return LocalFileManager.deleteFile(key + "." + format, "book");
        } else {
          return localforage.removeItem(key);
        }
      }
    } catch (error) {
      console.error("delete book error:", error);
    }
  }
  static isBookExist(key: string, format: string, bookPath: string) {
    return new Promise<boolean>((resolve) => {
      if (isElectron) {
        var fs = window.require("fs");
        var path = window.require("path");
        let plainBookPath = path.join(
          getStorageLocation() || "",
          `book`,
          getPlainBookFileName(key, format)
        );
        let encryptedBookPath = path.join(
          getStorageLocation() || "",
          `book`,
          getEncryptedBookFileName(key, format)
        );

        if (key.startsWith("cache")) {
          resolve(fs.existsSync(plainBookPath) || fs.existsSync(encryptedBookPath));
        } else if (
          (bookPath && fs.existsSync(bookPath)) ||
          fs.existsSync(plainBookPath) ||
          fs.existsSync(encryptedBookPath)
        ) {
          resolve(true);
        } else {
          resolve(false);
        }
      } else {
        if (ConfigService.getItem("isUseLocal") === "yes") {
          LocalFileManager.fileExists(key + "." + format, "book").then(
            (exists) => {
              resolve(exists);
            }
          );
        } else {
          localforage.getItem(key).then((result) => {
            if (result) {
              resolve(true);
            } else {
              resolve(false);
            }
          });
        }
      }
    });
  }
  static fetchBook(
    key: string,
    format: string,
    isArrayBuffer: boolean = false,
    bookPath: string
  ) {
    if (isElectron) {
      return new Promise<File | ArrayBuffer | boolean>((resolve) => {
        var fs = window.require("fs");
        var path = window.require("path");
        const plainBookPath = path.join(
          getStorageLocation() || "",
          `book`,
          getPlainBookFileName(key, format)
        );
        const encryptedBookPath = path.join(
          getStorageLocation() || "",
          `book`,
          getEncryptedBookFileName(key, format)
        );

        (async () => {
          let data: Buffer | null = null;
          let isEncryptedFile = false;

          if (fs.existsSync(plainBookPath)) {
            data = fs.readFileSync(plainBookPath);
          } else if (fs.existsSync(encryptedBookPath)) {
            data = fs.readFileSync(encryptedBookPath);
            isEncryptedFile = true;
          } else if (bookPath && fs.existsSync(bookPath)) {
            data = fs.readFileSync(bookPath);
            isEncryptedFile = isEncryptedMarkedFileName(getFileNameFromPath(bookPath));
          } else {
            resolve(false);
            return;
          }

          if (!data) {
            resolve(false);
            return;
          }

          let contentBuffer = bufferToArrayBuffer(data);

          if (isEncryptedFile) {
            const decryptedResult = await decryptBookPayload(contentBuffer);
            if (!decryptedResult.success) {
              resolve(false);
              return;
            }
            contentBuffer = decryptedResult.data;
          } else {
            const maybeEncrypted = await decryptBookPayload(contentBuffer);
            if (maybeEncrypted.encrypted) {
              if (!maybeEncrypted.success) {
                resolve(false);
                return;
              }
              contentBuffer = maybeEncrypted.data;
            }
          }

          let blobTemp = new Blob([contentBuffer]);
          let fileTemp = new File([blobTemp], "data", {
            lastModified: new Date().getTime(),
            type: blobTemp.type,
          });

          if (isArrayBuffer) {
            resolve(contentBuffer);
          } else {
            resolve(fileTemp);
          }
        })();
      });
    } else {
      if (ConfigService.getItem("isUseLocal") === "yes") {
        return LocalFileManager.readFile(
          key + "." + format,
          "book"
        ) as Promise<ArrayBuffer>;
      } else {
        return localforage.getItem(key) as Promise<ArrayBuffer>;
      }
    }
  }
  static getBookPath(book: Book) {
    if (isElectron) {
      var fs = window.require("fs");
      var path = window.require("path");
      let plainBookPath = path.join(
        getStorageLocation() || "",
        `book`,
        getPlainBookFileName(book.key, book.format)
      );
      let encryptedBookPath = path.join(
        getStorageLocation() || "",
        `book`,
        getEncryptedBookFileName(book.key, book.format)
      );
      if (fs.existsSync(plainBookPath)) {
        return plainBookPath;
      } else if (fs.existsSync(encryptedBookPath)) {
        return encryptedBookPath;
      } else if (book.path && fs.existsSync(book.path)) {
        return book.path;
      } else {
        return "";
      }
    } else {
      return "";
    }
  }
  static fetchAllBooks(Books: BookModel[]) {
    return Books.map((item) => {
      return this.fetchBook(
        item.key,
        item.format.toLowerCase(),
        true,
        item.path
      );
    });
  }
  static async redirectBook(book: BookModel) {
    if (
      !(await this.isBookExist(
        book.key,
        book.format.toLowerCase(),
        book.path
      )) &&
      !(await this.isBookExist("cache-" + book.key, "zip", book.path))
    ) {
      if (!ConfigService.getItem("defaultSyncOption")) {
        toast(
          i18n.t("Please add data source in the setting-Sync and backup first")
        );
        return;
      }
      toast.loading(i18n.t("Downloading"), {
        id: "offline-book",
      });
      if (
        (await TokenService.getToken("is_authed")) === "yes" &&
        (await this.isBookExistInCloud(book.key, book.format))
      ) {
        let timer = showDownloadProgress(
          ConfigService.getItem("defaultSyncOption") || "",
          "cloud",
          book.size
        );
        let result = await this.downloadBook(book.key, book.format);
        clearInterval(timer);
        toast.dismiss("offline-book");

        let covers = await CoverUtil.getCloudCoverList();
        for (let cover of covers) {
          if (cover.startsWith(book.key)) {
            await CoverUtil.downloadCover(cover);
          }
        }

        if (result) {
          toast.success(i18n.t("Download successful"), {
            id: "offline-book",
          });
        } else {
          let result = await this.downloadCacheBook(book.key);
          if (result) {
            toast.success(i18n.t("Download successful"), {
              id: "offline-book",
            });
          } else {
            toast.error(i18n.t("Download failed"), {
              id: "offline-book",
            });
            if (ConfigService.getItem("defaultSyncOption") === "adrive") {
              toast.error(
                i18n.t(
                  "Aliyun Drive imposes strict limits on concurrent downloads. It is recommended that you wait 10 seconds before attempting to download again."
                ),
                {
                  id: "offline-book",
                }
              );
            }
            return;
          }
        }
      } else {
        toast.error(i18n.t("Book not exists"), {
          id: "offline-book",
        });
        return;
      }
    }
    let ref = book.format.toLowerCase();

    if (isElectron) {
      if (ConfigService.getReaderConfig("isOpenInMain") === "yes") {
        window.require("electron").ipcRenderer.invoke("new-tab", {
          url: `${window.location.href.split("#")[0]}#/${ref}/${book.key
            }?title=${book.name}&file=${book.key}`,
        });
      } else {
        const { ipcRenderer } = window.require("electron");
        ipcRenderer.invoke("open-book", {
          url: `${window.location.href.split("#")[0]}#/${ref}/${book.key
            }?title=${book.name}&file=${book.key}`,
          isMergeWord: ConfigService.getReaderConfig("isMergeWord"),
          isAutoFullscreen: ConfigService.getReaderConfig("isAutoFullscreen"),
          isAutoMaximize: ConfigService.getReaderConfig("isAutoMaximize"),
          isPreventSleep: ConfigService.getReaderConfig("isPreventSleep"),
          isAlwaysOnTop: ConfigService.getReaderConfig("isAlwaysOnTop"),
        });
      }
    } else {
      window.open(
        `${window.location.href.split("#")[0]}#/${ref}/${book.key}?title=${book.name
        }&file=${book.key}`
      );
    }
  }
  static getBookUrl(book: BookModel) {
    let ref = book.format.toLowerCase();
    return `/${ref}/${book.key}`;
  }
  static reloadBooks(currentBook: BookModel) {
    if (isElectron) {
      if (ConfigService.getReaderConfig("isOpenInMain") === "yes") {
        window
          .require("electron")
          .ipcRenderer.invoke("reload-tab", { bookKey: currentBook.key });
      } else {
        window.require("electron").ipcRenderer.invoke("reload-reader", {
          bookKey: currentBook.key,
        });
      }
    } else {
      window.location.reload();
    }
  }
  static async isBookExistInCloud(key: string, format: string) {
    let service = ConfigService.getItem("defaultSyncOption");
    if (!service) {
      return false;
    }
    if (isElectron) {
      const { ipcRenderer } = window.require("electron");

      let tokenConfig = await getCloudConfig(service);

      const encryptedExist = await ipcRenderer.invoke("cloud-exist", {
        ...tokenConfig,
        fileName: getEncryptedBookFileName(key, format),
        service: service,
        type: "book",
        storagePath: getStorageLocation(),
      });

      if (encryptedExist) {
        return true;
      }

      return await ipcRenderer.invoke("cloud-exist", {
        ...tokenConfig,
        fileName: getPlainBookFileName(key, format),
        service: service,
        type: "book",
        storagePath: getStorageLocation(),
      });
    } else {
      let syncUtil = await SyncService.getSyncUtil();
      const encryptedExist = await syncUtil.isExist(
        getEncryptedBookFileName(key, format),
        "book"
      );
      if (encryptedExist) {
        return true;
      }
      return await syncUtil.isExist(getPlainBookFileName(key, format), "book");
    }
  }
  static async downloadCacheBook(key: string) {
    let service = ConfigService.getItem("defaultSyncOption");
    if (!service) {
      return false;
    }
    if (isElectron) {
      const { ipcRenderer } = window.require("electron");

      let tokenConfig = await getCloudConfig(service);

      let result = await ipcRenderer.invoke("cloud-download", {
        ...tokenConfig,
        fileName: getEncryptedBookFileName("cache-" + key, "zip"),
        service: service,
        type: "book",
        storagePath: getStorageLocation(),
      });

      if (result) {
        const fs = window.require("fs");
        const path = window.require("path");
        const dataPath = getStorageLocation() || "";
        const encryptedPath = path.join(
          dataPath,
          "book",
          getEncryptedBookFileName("cache-" + key, "zip")
        );
        const plainPath = path.join(
          dataPath,
          "book",
          getPlainBookFileName("cache-" + key, "zip")
        );

        if (fs.existsSync(encryptedPath)) {
          const encryptedBuffer = bufferToArrayBuffer(fs.readFileSync(encryptedPath));
          const decrypted = await decryptBookPayload(encryptedBuffer);
          if (!decrypted.success) {
            return false;
          }
          fs.writeFileSync(plainPath, Buffer.from(decrypted.data));
          fs.unlinkSync(encryptedPath);
          return true;
        }
      }

      result = await ipcRenderer.invoke("cloud-download", {
        ...tokenConfig,
        fileName: getPlainBookFileName("cache-" + key, "zip"),
        service: service,
        type: "book",
        storagePath: getStorageLocation(),
      });
      if (!result) {
        console.error("download cache failed");
        return false;
      }
      return true;
    } else {
      let syncUtil = await SyncService.getSyncUtil();

      let encryptedCache = await syncUtil.downloadFile(
        getEncryptedBookFileName("cache-" + key, "zip"),
        "book"
      );

      if (encryptedCache) {
        const decrypted = await decryptBookPayload(encryptedCache);
        if (!decrypted.success) {
          return false;
        }
        await this.addBook("cache-" + key, "zip", decrypted.data);
        toast.dismiss("add-book");
        return true;
      }

      let cache = await syncUtil.downloadFile(
        getPlainBookFileName("cache-" + key, "zip"),
        "book"
      );
      if (!cache) {
        console.error("download cache failed");
        return false;
      }
      await this.addBook("cache-" + key, "zip", cache);
      toast.dismiss("add-book");
      return true;
    }
  }
  static async downloadBook(key: string, format: string) {
    let service = ConfigService.getItem("defaultSyncOption");
    if (!service) {
      return;
    }
    if (isElectron) {
      const { ipcRenderer } = window.require("electron");

      let tokenConfig = await getCloudConfig(service);

      const encryptedFileName = getEncryptedBookFileName(key, format);
      const plainFileName = getPlainBookFileName(key, format);
      let result = await ipcRenderer.invoke("cloud-download", {
        ...tokenConfig,
        fileName: encryptedFileName,
        service: service,
        type: "book",
        storagePath: getStorageLocation(),
      });

      if (result) {
        const fs = window.require("fs");
        const path = window.require("path");
        const dataPath = getStorageLocation() || "";
        const encryptedPath = path.join(dataPath, "book", encryptedFileName);
        const plainPath = path.join(dataPath, "book", plainFileName);
        if (fs.existsSync(encryptedPath)) {
          const encryptedBuffer = bufferToArrayBuffer(fs.readFileSync(encryptedPath));
          const decrypted = await decryptBookPayload(encryptedBuffer);
          if (!decrypted.success) {
            return false;
          }
          fs.writeFileSync(plainPath, Buffer.from(decrypted.data));
          fs.unlinkSync(encryptedPath);
          return true;
        }
      }

      result = await ipcRenderer.invoke("cloud-download", {
        ...tokenConfig,
        fileName: plainFileName,
        service: service,
        type: "book",
        storagePath: getStorageLocation(),
      });
      return result;
    } else {
      let syncUtil = await SyncService.getSyncUtil();

      const encryptedFileName = getEncryptedBookFileName(key, format);
      const plainFileName = getPlainBookFileName(key, format);
      let encryptedBuffer = await syncUtil.downloadFile(
        encryptedFileName,
        "book"
      );

      if (encryptedBuffer) {
        const decrypted = await decryptBookPayload(encryptedBuffer);
        if (!decrypted.success) {
          return false;
        }
        if (ConfigService.getItem("isUseLocal") === "yes") {
          await LocalFileManager.saveFile(plainFileName, decrypted.data, "book");
        } else {
          await localforage.setItem(key, decrypted.data);
        }
        toast.dismiss("add-book");
        return true;
      }

      let bookBuffer = await syncUtil.downloadFile(plainFileName, "book");
      if (!bookBuffer) {
        return false;
      }

      if (ConfigService.getItem("isUseLocal") === "yes") {
        await LocalFileManager.saveFile(plainFileName, bookBuffer, "book");
      } else {
        await localforage.setItem(key, bookBuffer);
      }
      toast.dismiss("add-book");
      return true;
    }
  }
  static async uploadBook(key: string, format: string) {
    if (key.startsWith("cache")) {
      return;
    }
    let isAuthed = await TokenService.getToken("is_authed");
    if (isAuthed !== "yes") {
      return;
    }
    let service = ConfigService.getItem("defaultSyncOption");
    if (!service) {
      return;
    }
    if (isElectron) {
      const { ipcRenderer } = window.require("electron");

      const fs = window.require("fs");
      const path = window.require("path");
      const dataPath = getStorageLocation() || "";
      const plainFileName = getPlainBookFileName(key, format);
      const encryptedFileName = getEncryptedBookFileName(key, format);
      const plainPath = path.join(dataPath, "book", plainFileName);
      const encryptedPath = path.join(dataPath, "book", encryptedFileName);

      if (!fs.existsSync(plainPath)) {
        return;
      }

      const rawBuffer = bufferToArrayBuffer(fs.readFileSync(plainPath));
      const encryptedBuffer = await encryptBookPayload(rawBuffer);
      fs.writeFileSync(encryptedPath, Buffer.from(encryptedBuffer));

      let tokenConfig = await getCloudConfig(service);
      try {
        let result = await ipcRenderer.invoke("cloud-upload", {
          ...tokenConfig,
          fileName: encryptedFileName,
          service: service,
          type: "book",
          storagePath: getStorageLocation(),
        });
        if (!result) {
          toast.error(i18n.t("Upload failed"), {
            id: "upload-book",
          });
          return;
        }
      } finally {
        if (fs.existsSync(encryptedPath)) {
          fs.unlinkSync(encryptedPath);
        }
      }
    } else {
      let syncUtil = await SyncService.getSyncUtil();
      let bookBuffer: any = await this.fetchBook(key, format, true, "");
      if (!bookBuffer) {
        return;
      }
      const encryptedBuffer = await encryptBookPayload(bookBuffer as ArrayBuffer);
      let bookBlob = new Blob([bookBuffer], {
        type: CommonTool.getMimeType(format.toLowerCase()),
      });
      let result = await syncUtil.uploadFile(
        getEncryptedBookFileName(key, format),
        "book",
        new Blob([encryptedBuffer], { type: bookBlob.type })
      );
      if (!result) {
        toast.error(i18n.t("Upload failed"), {
          id: "upload-book",
        });
        return;
      }
    }
  }
  static async deleteCloudBook(key: string, format: string) {
    let isAuthed = await TokenService.getToken("is_authed");
    if (isAuthed !== "yes") {
      return;
    }
    let service = ConfigService.getItem("defaultSyncOption");
    if (!service) {
      return;
    }
    if (isElectron) {
      const { ipcRenderer } = window.require("electron");

      let tokenConfig = await getCloudConfig(service);

      await ipcRenderer.invoke("cloud-delete", {
        ...tokenConfig,
        fileName: getEncryptedBookFileName(key, format),
        service: service,
        type: "book",
        storagePath: getStorageLocation(),
      });

      await ipcRenderer.invoke("cloud-delete", {
        ...tokenConfig,
        fileName: getPlainBookFileName(key, format),
        service: service,
        type: "book",
        storagePath: getStorageLocation(),
      });
    } else {
      let syncUtil = await SyncService.getSyncUtil();
      await syncUtil.deleteFile(getEncryptedBookFileName(key, format), "book");
      await syncUtil.deleteFile(getPlainBookFileName(key, format), "book");
    }
  }

  static async deleteCacheBook(key: string) {
    await this.deleteBook("cache-" + key, "zip");
  }
  static async offlineBook(key: string, format: string) {
    let result = await this.downloadBook(key, format);
    if (!result) {
      result = await this.downloadCacheBook(key);
    }
    return result;
  }
  static async deleteOfflineBook(key: string) {
    let book: Book = await DatabaseService.getRecord(key, "books");
    if (!book) {
      return;
    }
    await this.deleteBook(key, book.format.toLowerCase());
    await this.deleteCacheBook(key);
    await CoverUtil.deleteOfflineCover(key);
  }
  static async isBookOffline(key: string) {
    let book: Book = await DatabaseService.getRecord(key, "books");
    return await this.isBookExist(key, book.format.toLowerCase(), book.path);
  }
  static async getLocalBookList() {
    let books: Book[] = (await DatabaseService.getAllRecords("books")) || [];
    let fileList: string[] = [];
    for (let book of books) {
      if (await this.isBookExist(book.key, book.format.toLowerCase(), "")) {
        fileList.push(book.key + "." + book.format.toLowerCase());
      }
      if (await this.isBookExist("cache-" + book.key, "zip", "")) {
        fileList.push("cache-" + book.key + ".zip");
      }
    }
    return fileList;
  }
  static async getCloudBookList() {
    let service = ConfigService.getItem("defaultSyncOption");
    if (!service) {
      return [];
    }
    if (isElectron) {
      const { ipcRenderer } = window.require("electron");

      let tokenConfig = await getCloudConfig(service);

      const cloudList = await ipcRenderer.invoke("cloud-list", {
        ...tokenConfig,
        service: service,
        type: "book",
        storagePath: getStorageLocation(),
      });
      return Array.from(
        new Set(
          (cloudList || []).map((fileName: string) =>
            removeEncryptedMarkerFromFileName(fileName)
          )
        )
      );
    } else {
      let syncUtil = await SyncService.getSyncUtil();
      let cloudBookList = await syncUtil.listFiles("book");
      return Array.from(
        new Set(
          (cloudBookList || []).map((fileName: string) =>
            removeEncryptedMarkerFromFileName(fileName)
          )
        )
      );
    }
  }
  static async getBookNamesMapByKeys(bookKeys: string[]) {
    if (bookKeys.length === 0) {
      return {};
    }
    if (isElectron) {
      const { ipcRenderer } = window.require("electron");
      let placeholders = bookKeys.map(() => "?").join(",");
      let query = `SELECT key, name FROM books WHERE key IN (${placeholders})`;
      let results = await ipcRenderer.invoke("custom-database-command", {
        query: query,
        data: bookKeys,
        dbName: "books",
        storagePath: getStorageLocation(),
        executeType: "all",
      });
      let map: { [key: string]: string } = {};
      for (let item of results) {
        map[item.key] = item.name;
      }
      return map;
    } else {
      let books: Book[] = (await DatabaseService.getAllRecords("books")) || [];
      let map: { [key: string]: string } = {};
      for (let book of books) {
        if (bookKeys.includes(book.key)) {
          map[book.key] = book.name;
        }
      }
      return map;
    }
  }
  static async getBookKeysWithSort(sortField: string, orderField: string) {
    if (isElectron) {
      const { ipcRenderer } = window.require("electron");
      // Get all books first, then sort in JavaScript for natural sorting
      let results = await ipcRenderer.invoke("custom-database-command", {
        query: `SELECT key, ${sortField} FROM books`,
        dbName: "books",
        storagePath: getStorageLocation(),
        executeType: "all",
      });

      if (sortField === "name" || sortField === "author") {
        results.sort((a: any, b: any) => {
          const comparison = a[sortField].localeCompare(
            b[sortField],
            undefined,
            { numeric: true, sensitivity: "base" }
          );
          return orderField === "ASC" ? comparison : -comparison;
        });
      } else if (sortField === "key") {
        if (orderField === "DESC") {
          results = results.reverse();
        }
      } else {
        results.sort((a: any, b: any) => {
          const comparison = (a[sortField] || 0) - (b[sortField] || 0);
          return orderField === "ASC" ? comparison : -comparison;
        });
      }

      return results.map((item: any) => ({ key: item.key }));
    } else {
      let books: Book[] = (await DatabaseService.getAllRecords("books")) || [];
      if (sortField === "name") {
        books.sort((a, b) => {
          const comparison = a.name.localeCompare(b.name, undefined, {
            numeric: true,
            sensitivity: "base",
          });
          return orderField === "ASC" ? comparison : -comparison;
        });
        return books.map((item) => {
          return { key: item.key };
        });
      } else if (sortField === "author") {
        books.sort((a, b) => {
          const comparison = a.author.localeCompare(b.author, undefined, {
            numeric: true,
            sensitivity: "base",
          });
          return orderField === "ASC" ? comparison : -comparison;
        });
        return books.map((item) => {
          return { key: item.key };
        });
      } else if (sortField === "key") {
        if (orderField === "DESC") {
          books = books.reverse();
        }
        return books.map((item) => {
          return { key: item.key };
        });
      } else {
        books.sort((a, b) => {
          const comparison =
            ((a as any)[sortField] || 0) - ((b as any)[sortField] || 0);
          return orderField === "ASC" ? comparison : -comparison;
        });
        return books.map((item) => {
          return { key: item.key };
        });
      }
    }
  }
  static async getBookByMd5(md5: string) {
    if (isElectron) {
      const { ipcRenderer } = window.require("electron");
      return await ipcRenderer.invoke("custom-database-command", {
        query: `SELECT * FROM books WHERE md5=? LIMIT 1`,
        data: [md5],
        dbName: "books",
        storagePath: getStorageLocation(),
        executeType: "get",
      });
    } else {
      let books: Book[] = (await DatabaseService.getAllRecords("books")) || [];
      for (let book of books) {
        if (book.md5 === md5) {
          return book;
        }
      }
      return null;
    }
  }
  static async getPDFBookByMd5(md5: string) {
    if (!md5) {
      return null;
    }
    if (isElectron) {
      const { ipcRenderer } = window.require("electron");
      return await ipcRenderer.invoke("custom-database-command", {
        query: `SELECT * FROM books WHERE md5 LIKE ? LIMIT 1`,
        data: [`%${md5}%`],
        dbName: "books",
        storagePath: getStorageLocation(),
        executeType: "get",
      });
    } else {
      let books: Book[] = (await DatabaseService.getAllRecords("books")) || [];
      for (let book of books) {
        if (book.md5 && book.md5.includes(md5)) {
          return book;
        }
      }
      return null;
    }
  }
  static async searchBooksByKeyword(keyword: string) {
    if (isElectron) {
      const { ipcRenderer } = window.require("electron");
      return await ipcRenderer.invoke("custom-database-command", {
        query: `SELECT * FROM books WHERE name LIKE ? OR author LIKE ?`,
        data: [`%${keyword}%`, `%${keyword}%`],
        dbName: "books",
        storagePath: getStorageLocation(),
        executeType: "all",
      });
    } else {
      let books: Book[] = (await DatabaseService.getAllRecords("books")) || [];
      let results: Book[] = [];
      const lowerKeyword = keyword.toLowerCase();
      for (let book of books) {
        if (
          book.name.toLowerCase().includes(lowerKeyword) ||
          book.author.toLowerCase().includes(lowerKeyword)
        ) {
          results.push(book);
        }
      }
      return results;
    }
  }
  static async getBookList() {
    if (isElectron) {
      const { ipcRenderer } = window.require("electron");
      return await ipcRenderer.invoke("custom-database-command", {
        query: `SELECT key, format, md5, path FROM books`,
        dbName: "books",
        storagePath: getStorageLocation(),
        executeType: "all",
      });
    } else {
      let books: Book[] = (await DatabaseService.getAllRecords("books")) || [];
      return books;
    }
  }
}

export default BookUtil;
