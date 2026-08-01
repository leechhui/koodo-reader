import CryptoJS from "crypto-js";

const BOOK_ENCRYPTION_MAGIC = "KDR_AES_V1:";
const BOOK_ENCRYPTION_KEY_V1 = "koodo-reader-book-crypto-v1";
const KNOWN_BOOK_EXTENSIONS = new Set([
    "epub",
    "pdf",
    "txt",
    "mobi",
    "azw3",
    "azw",
    "htm",
    "html",
    "xml",
    "xhtml",
    "mhtml",
    "docx",
    "md",
    "fb2",
    "cbz",
    "cbt",
    "cbr",
    "cb7",
    "zip",
]);

export interface BookDecryptResult {
    data: ArrayBuffer;
    encrypted: boolean;
    success: boolean;
}

interface BookCryptoProvider {
    readonly algorithm: string;
    encrypt(data: ArrayBuffer): Promise<ArrayBuffer>;
    decrypt(data: ArrayBuffer): Promise<BookDecryptResult>;
}

const toWordArray = (buffer: ArrayBuffer): CryptoJS.lib.WordArray => {
    return CryptoJS.lib.WordArray.create(new Uint8Array(buffer));
};

const fromWordArray = (wordArray: CryptoJS.lib.WordArray): ArrayBuffer => {
    const words = wordArray.words;
    const sigBytes = wordArray.sigBytes;
    const bytes = new Uint8Array(sigBytes);

    for (let i = 0; i < sigBytes; i++) {
        const word = words[i >>> 2];
        bytes[i] = (word >>> (24 - (i % 4) * 8)) & 0xff;
    }

    return bytes.buffer;
};

const toUtf8Buffer = (text: string): ArrayBuffer => {
    return new TextEncoder().encode(text).buffer;
};

const fromUtf8Buffer = (buffer: ArrayBuffer): string => {
    return new TextDecoder().decode(new Uint8Array(buffer));
};

const aesCryptoProvider: BookCryptoProvider = {
    algorithm: "aes-v1",
    async encrypt(data: ArrayBuffer): Promise<ArrayBuffer> {
        const wordArray = toWordArray(data);
        const encrypted = CryptoJS.AES.encrypt(wordArray, BOOK_ENCRYPTION_KEY_V1)
            .toString()
            .trim();
        return toUtf8Buffer(`${BOOK_ENCRYPTION_MAGIC}${encrypted}`);
    },
    async decrypt(data: ArrayBuffer): Promise<BookDecryptResult> {
        let decoded = "";
        try {
            decoded = fromUtf8Buffer(data);
        } catch (error) {
            return { data, encrypted: false, success: true };
        }

        if (!decoded.startsWith(BOOK_ENCRYPTION_MAGIC)) {
            return { data, encrypted: false, success: true };
        }

        const cipherText = decoded.substring(BOOK_ENCRYPTION_MAGIC.length);
        if (!cipherText) {
            return { data, encrypted: true, success: false };
        }

        try {
            const decrypted = CryptoJS.AES.decrypt(cipherText, BOOK_ENCRYPTION_KEY_V1);
            if (!decrypted.sigBytes || decrypted.sigBytes <= 0) {
                return { data, encrypted: true, success: false };
            }
            return {
                data: fromWordArray(decrypted),
                encrypted: true,
                success: true,
            };
        } catch (error) {
            return { data, encrypted: true, success: false };
        }
    },
};

const currentBookCryptoProvider: BookCryptoProvider = aesCryptoProvider;

export const getBookCryptoAlgorithm = (): string => {
    return currentBookCryptoProvider.algorithm;
};

export const encryptBookPayload = async (
    data: ArrayBuffer
): Promise<ArrayBuffer> => {
    return currentBookCryptoProvider.encrypt(data);
};

export const decryptBookPayload = async (
    data: ArrayBuffer
): Promise<BookDecryptResult> => {
    return currentBookCryptoProvider.decrypt(data);
};

const splitFileName = (
    fileName: string
): { name: string; ext: string } | null => {
    const lastDot = fileName.lastIndexOf(".");
    if (lastDot <= 0 || lastDot === fileName.length - 1) {
        return null;
    }
    return {
        name: fileName.substring(0, lastDot),
        ext: fileName.substring(lastDot + 1),
    };
};

export const addEncryptedMarkerToFileName = (fileName: string): string => {
    const parts = splitFileName(fileName);
    if (!parts) return fileName;
    if (isEncryptedMarkedFileName(fileName)) return fileName;
    return `${parts.name}.e${parts.ext}`;
};

export const removeEncryptedMarkerFromFileName = (fileName: string): string => {
    const parts = splitFileName(fileName);
    if (!parts) return fileName;
    if (!isEncryptedMarkedFileName(fileName)) return fileName;
    return `${parts.name}.${parts.ext.substring(1)}`;
};

export const isEncryptedMarkedFileName = (fileName: string): boolean => {
    const parts = splitFileName(fileName);
    if (!parts) return false;
    const ext = parts.ext.toLowerCase();
    if (!ext.startsWith("e") || ext.length <= 1) {
        return false;
    }
    return KNOWN_BOOK_EXTENSIONS.has(ext.substring(1));
};

export const getPlainBookFileName = (key: string, format: string): string => {
    return `${key}.${format.toLowerCase()}`;
};

export const getEncryptedBookFileName = (key: string, format: string): string => {
    return `${key}.e${format.toLowerCase()}`;
};
