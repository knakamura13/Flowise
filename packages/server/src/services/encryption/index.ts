import { randomBytes } from 'crypto'
import { getEncryptionKeyPath } from 'flowise-components'
import fs from 'fs'

import { AES } from 'crypto-js'
import { StatusCodes } from 'http-status-codes'
import { Encryption } from '../../database/entities/Encryption'
import { InternalFlowiseError } from '../../errors/internalFlowiseError'
import { getErrorMessage } from '../../errors/utils'
import { ICredentialDataDecrypted } from '../../Interface'
import { getRunningExpressApp } from '../../utils/getRunningExpressApp'

/**
 * Generate an encryption key
 * @returns {string}
 */
const generate = async (): Promise<Encryption> => {
    try {
        const appServer = getRunningExpressApp()

        // step 1 - get value of FLOWISE_SECRETKEY_OVERWRITE
        let SECRETKEY_OVERWRITE: string = ''
        if (process.env.FLOWISE_SECRETKEY_OVERWRITE !== undefined && process.env.FLOWISE_SECRETKEY_OVERWRITE !== '')
            SECRETKEY_OVERWRITE = process.env.FLOWISE_SECRETKEY_OVERWRITE

        // step 2 - get value of SECRETKEY_FROM_PATH if exists
        let SECRETKEY_FROM_PATH: string = ''
        try {
            SECRETKEY_FROM_PATH = await fs.promises.readFile(getEncryptionKeyPath(), 'utf8')
        } catch (error) {
            // bypass error if not found, there's no need to create this file anymore
        }

        // step 3 - get all encryptionKey values from database
        let dbFindResponse = await appServer.AppDataSource.getRepository(Encryption).find({ select: { encryptionKey: true } })
        const encryptionKeys = dbFindResponse.map((response) => {
            return response.encryptionKey
        })

        // step 4 - insert SECRETKEY into database if not duplicate
        let nameCounter: number = encryptionKeys.length
        const insertLegacyEncryption = async (SECRETKEY: string) => {
            if (SECRETKEY != '' && !encryptionKeys.includes(SECRETKEY)) {
                nameCounter += 1
                const newEncryption: Partial<Encryption> = { name: nameCounter.toString(), encryptionKey: SECRETKEY }
                await create(newEncryption)
            }
        }
        await insertLegacyEncryption(SECRETKEY_FROM_PATH)
        await insertLegacyEncryption(SECRETKEY_OVERWRITE)

        // step 5 - return value based on latest updated date
        try {
            return await get()
        } catch (error) {
            // bypass error if no encryptionKey found in database
        }

        // step 6 - will reach when there are no encryptionKey value created in SECRETKEY_OVERWRITE, SECRETKEY_FROM_PATH and encryption table in database
        nameCounter += 1
        const newEncryption: Partial<Encryption> = { name: nameCounter.toString() }
        return await create(newEncryption)
    } catch (error) {
        throw new InternalFlowiseError(StatusCodes.INTERNAL_SERVER_ERROR, `Error: encryptionService.generate - ${getErrorMessage(error)}`)
    }
}

/**
 * Return new encryption
 * @param {Partial<Encryption>} credential
 * @returns {Promise<Encryption>}
 */
const create = async (encryption: Partial<Encryption>): Promise<Encryption> => {
    try {
        const appServer = getRunningExpressApp()

        // step 1 - check whether encryption key is undefined, if yes generate new key
        if (!encryption.encryptionKey) encryption.encryptionKey = randomBytes(24).toString('base64')

        // step 2 - check whether encryption name is undefined, if yes throw error
        if (!encryption.name) throw new Error('Please provide a name for this encryption.')

        // step 3 - save into database's encryption table
        const newEncryption = await appServer.AppDataSource.getRepository(Encryption).create(encryption)
        await appServer.AppDataSource.getRepository(Encryption).save(newEncryption)

        // step 4 - return new encryption
        return newEncryption
    } catch (error) {
        throw new InternalFlowiseError(StatusCodes.INTERNAL_SERVER_ERROR, `Error: encryptionService.create - ${getErrorMessage(error)}`)
    }
}

/**
 * Return correct encryption based on database's encryption_credential table
 * @param {Credential} credential
 * @returns {Promise<Encryption>}
 */
const get = async (credential?: Credential): Promise<Encryption> => {
    try {
        const appServer = getRunningExpressApp()

        // step 1 - if credentialId have input find it's own encryption through database's encryption_credential, encryption and credentialId tables
        if (credential) {
            const credentialId: string = credential.id
            const dbResponse: Encryption[] = await appServer.AppDataSource.createQueryBuilder()
                .leftJoinAndSelect('encryption_credential', 'ec', 'ec.credentialId = c.id')
                .leftJoinAndSelect('encryption', 'e', 'e.id = ec.encryptionId')
                .where('c.id = :credentialId', { credentialId })
                .select(['e'])
                .getRawMany()
            if (dbResponse.length == 1) return dbResponse[0]
            // if found multiple encryption key then probably need to loop through and check which encryption key is the correct for this credential?
            // I don't think it will return multiple encryption key as it will only return 1 encryption key
            else if (dbResponse.length > 1) console.error(`credentialId: ${credential.id} have multiple encryptionKey`)
        }

        // step 2 - return latest latest encryption based on updatedDate descending
        const dbResponse = await appServer.AppDataSource.getRepository(Encryption).find({
            select: { id: true, encryptionKey: true },
            order: { updatedDate: 'DESC' }
        })
        if (dbResponse.length != 0) {
            return dbResponse[0]
        }

        //step 3 - not able to find encryption key
        throw new Error('No encryption key available')
    } catch (error) {
        throw new InternalFlowiseError(StatusCodes.INTERNAL_SERVER_ERROR, `Error: encryptionService.get - ${getErrorMessage(error)}`)
    }
}

/**
 * Encrypt credential data
 * @param {ICredentialDataDecrypted} plainDataObj
 * @param {Encryption} encryption
 * @returns {Promise<string>}
 */
export const encrypt = async (plainDataObj: ICredentialDataDecrypted, encryption?: Encryption): Promise<string> => {
    try {
        if (!encryption) encryption = await get()
        return AES.encrypt(JSON.stringify(plainDataObj), encryption.encryptionKey).toString()
    } catch (error) {
        throw new InternalFlowiseError(StatusCodes.INTERNAL_SERVER_ERROR, `Error: encryptionService.encrypt - ${getErrorMessage(error)}`)
    }
}

export default {
    create,
    encrypt,
    generate,
    get
}
