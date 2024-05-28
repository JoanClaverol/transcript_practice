////////////////////////////////////////////////////////////////////////////////
// S3 BUCKET
////////////////////////////////////////////////////////////////////////////////
import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
} from "@aws-sdk/client-s3";
import parser from "lambda-multipart-parser";
import { v4 as uuidv4 } from "uuid";

const REGION = "eu-west-3";
const BUCKET_NAME = "cloud-translator-app-bucket";

const s3Client = new S3Client({ region: REGION });

const getLanguageCode = (language) => {
  switch (language) {
    case "spanish":
      return "es-ES";
    case "catalan":
      return "ca-ES";
    case "german":
      return "de-DE";
    case "english":
      return "en-GB";
    case "french":
      return "fr-FR";
    default:
      return "en-US"; // Default case if language does not match
  }
};

export const uploadHandler = async (event) => {
  try {
    console.log("Parsing event:", event);

    // Parse the multipart form data
    const result = await parser.parse(event);
    console.log("Parsed result:", result);

    // Validate file presence
    if (!result.files || result.files.length === 0) {
      console.log("No files uploaded");
      return {
        statusCode: 400,
        body: JSON.stringify({ error: "No files uploaded" }),
      };
    }

    const file = result.files[0];

    // Check file content length
    if (file.content.length === 0) {
      console.log("Uploaded file is empty");
      return {
        statusCode: 400,
        body: JSON.stringify({ error: "Uploaded file is empty" }),
      };
    }

    console.log(result.inputLanguage);
    console.log(getLanguageCode(result.inputLanguage));
    console.log(result.outputLanguage);
    console.log(getLanguageCode(result.outputLanguage));

    const inputLanguage = getLanguageCode(result.inputLanguage);
    const outputLanguage = getLanguageCode(result.outputLanguage);

    // Create a new filename by prepending the unique identifier
    const newFilename = `${uuidv4()}_${file.filename}`;
    console.log("New filename:", newFilename);

    // Prepare the input for the S3 command
    const input = {
      ACL: "private",
      Body: file.content,
      Bucket: BUCKET_NAME,
      Key: `voice_input/${newFilename}`,
      StorageClass: "STANDARD",
      Metadata: {
        inputLanguage,
        outputLanguage,
      },
    };

    console.log("S3 input parameters:", input);

    const command = new PutObjectCommand(input);
    await s3Client.send(command);

    console.log("File uploaded successfully to S3");

    return {
      statusCode: 200,
      body: JSON.stringify({
        message: "File uploaded successfully",
        fileName: newFilename,
        inputLanguage,
        outputLanguage,
      }),
    };
  } catch (error) {
    console.error("Error in uploadHandler:", error);
    return {
      statusCode: 500,
      body: JSON.stringify({ error: "An error occurred during file upload" }),
    };
  }
};

////////////////////////////////////////////////////////////////////////////////
// TRANSCRIPTION
////////////////////////////////////////////////////////////////////////////////
import {
  TranscribeClient,
  StartTranscriptionJobCommand,
  GetTranscriptionJobCommand,
} from "@aws-sdk/client-transcribe";

const transcribeClient = new TranscribeClient({ region: REGION });

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export const transcribeHandler = async (data) => {
  console.log(`Processing audio: ${data.fileName}`);

  const bucketName = BUCKET_NAME;
  const objectKey = data.fileName;
  const inputLanguage = data.inputLanguage; // Get the input language

  console.log(`Processing audio for bucket: ${bucketName}, key: ${objectKey}`);

  const audioUrl = `https://${bucketName}.s3.amazonaws.com/voice_input/${objectKey}`;
  console.log(`Audio file URL: ${audioUrl}`);

  const transcriptionJobName = `transcription-${Date.now()}`;
  console.log(`Generated transcription job name: ${transcriptionJobName}`);

  const OutputKey = `transcription_texts/${objectKey
    .split("/")
    .pop()
    .replace(/\.[^/.]+$/, "")}.json`;
  const transcriptionParams = {
    TranscriptionJobName: transcriptionJobName,
    LanguageCode: inputLanguage, // Use the input language
    MediaFormat: "webm", // mp3
    Media: {
      MediaFileUri: audioUrl,
    },
    OutputBucketName: bucketName,
    OutputKey: OutputKey,
  };

  console.log(
    "Starting transcription job with params:",
    JSON.stringify(transcriptionParams, null, 2)
  );
  const startCommand = new StartTranscriptionJobCommand(transcriptionParams);
  await transcribeClient.send(startCommand);

  console.log("Transcription job started successfully");

  // Poll for job completion
  let jobStatus = "IN_PROGRESS";
  while (jobStatus === "IN_PROGRESS") {
    console.log("Waiting for transcription job to complete...");
    await delay(5000); // Wait for 5 seconds before polling again

    const getJobParams = { TranscriptionJobName: transcriptionJobName };
    const getJobCommand = new GetTranscriptionJobCommand(getJobParams);
    const jobResponse = await transcribeClient.send(getJobCommand);

    jobStatus = jobResponse.TranscriptionJob.TranscriptionJobStatus;
    console.log(`Current job status: ${jobStatus}`);
  }

  if (jobStatus === "COMPLETED") {
    console.log("Transcription job completed successfully");

    const jobParams = { TranscriptionJobName: transcriptionJobName };
    const getJobCommand = new GetTranscriptionJobCommand(jobParams);
    const jobResponse = await transcribeClient.send(getJobCommand);

    const transcriptionUrl =
      jobResponse.TranscriptionJob.Transcript.TranscriptFileUri;
    console.log(`Transcription URL: ${transcriptionUrl}`);

    return {
      statusCode: 200,
      body: JSON.stringify({
        message: "Transcription job completed successfully",
        fileName: OutputKey,
        inputLanguage,
        outputLanguage: data.outputLanguage,
      }),
    };
  }
};

////////////////////////////////////////////////////////////////////////////////
// TRANSLATOR
////////////////////////////////////////////////////////////////////////////////
// import { S3Client, GetObjectCommand } from "@aws-sdk/client-s3";
import {
  TranslateClient,
  TranslateTextCommand,
} from "@aws-sdk/client-translate";

const translateClient = new TranslateClient({ region: REGION });

export const translateHandler = async (data) => {
  console.log(`Processing audio: ${data.fileName}`);

  const bucketName = BUCKET_NAME;
  const transcriptionKey = data.fileName;
  const inputLanguage = data.inputLanguage; // Get the input language
  const outputLanguage = data.outputLanguage; // Get the output language

  // Step 1: Get the file from S3
  console.log(
    `Fetching file from S3 bucket: ${bucketName}, key: ${transcriptionKey}`
  );
  const getObjectParams = {
    Bucket: bucketName,
    Key: transcriptionKey,
  };
  const getObjectCommand = new GetObjectCommand(getObjectParams);
  const getObjectResponse = await s3Client.send(getObjectCommand);

  let fileContent = "";
  for await (const chunk of getObjectResponse.Body) {
    fileContent += chunk;
  }
  console.log("File content retrieved");

  const jsonData = JSON.parse(fileContent);
  const textToTranslate = jsonData.results.transcripts[0].transcript;
  console.log(`Text to translate: ${textToTranslate}`);

  // Step 2: Translate the text
  console.log(`Translating the text to ${outputLanguage}`);
  const translateParams = {
    Text: textToTranslate,
    SourceLanguageCode: inputLanguage, // Use the input language
    TargetLanguageCode: outputLanguage, // Use the output language
  };
  const translateCommand = new TranslateTextCommand(translateParams);
  const translationResponse = await translateClient.send(translateCommand);

  const translatedText = translationResponse.TranslatedText;
  console.log(`Translated text: ${translatedText}`);

  // Step 3: Store the translated text back to S3
  const translatedObjectKey = `translate_texts/${transcriptionKey
    .split("/")
    .pop()
    .replace(/\.[^/.]+$/, "")}_translated.txt`;
  console.log(
    `Storing translated text to S3 bucket: ${bucketName}, key: ${translatedObjectKey}`
  );
  const putObjectParams = {
    Bucket: bucketName,
    Key: translatedObjectKey,
    Body: translatedText,
    ContentType: "text/plain",
  };
  const putObjectCommand = new PutObjectCommand(putObjectParams);
  await s3Client.send(putObjectCommand);

  console.log("Translated text stored successfully");

  return {
    statusCode: 200,
    body: JSON.stringify({ TranslatedText: translatedText, outputLanguage }),
  };
};

////////////////////////////////////////////////////////////////////////////////
// TEXT TO AUDIO
////////////////////////////////////////////////////////////////////////////////

import {
  PollyClient,
  StartSpeechSynthesisTaskCommand,
} from "@aws-sdk/client-polly";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

const pollyClient = new PollyClient({ region: REGION });

export const voiceHandler = async (data) => {
  const text = data.TranslatedText;
  const language = data.outputLanguage; // Get the Polly language code
  const outputFolder = "final_audio/";
  const voiceId = getVoiceId(language);

  const input = {
    Engine: "neural",
    LanguageCode: language,
    OutputFormat: "mp3",
    Text: text,
    VoiceId: voiceId,
    OutputS3BucketName: BUCKET_NAME,
    OutputS3KeyPrefix: outputFolder,
  };
  try {
    const command = new StartSpeechSynthesisTaskCommand(input);
    const responsePolly = await pollyClient.send(command);

    // Extract the S3 URI from the response
    const s3Uri = responsePolly.SynthesisTask.OutputUri;

    const { bucket, key } = parseS3Uri(s3Uri);

    // Generate a presigned URL for the object in S3
    const getObjectParams = {
      Bucket: bucket,
      Key: key,
    };

    const url = await getSignedUrl(
      s3Client,
      new GetObjectCommand(getObjectParams),
      { expiresIn: 3600 }
    );

    return {
      statusCode: 200,
      body: JSON.stringify({
        url,
      }),
    };
  } catch (error) {
    console.error(error);
    return {
      statusCode: 500,
      body: JSON.stringify({ error: "An error occurred" }),
    };
  }
};

const getVoiceId = (language) => {
  switch (language) {
    case "es-ES":
      return "Sergio";
    case "en-GB":
      return "Emma";
    case "de-DE":
      return "Daniel";
    case "ca-ES":
      return "Arlet";
    case "fr-FR":
      return "Celine"; // Added French voice
    default:
      return "Joanna"; // Default case if language does not match
  }
};

const parseS3Uri = (uri) => {
  const match = uri.split("/");
  if (!match) {
    throw new Error("Invalid S3 URI");
  }
  return {
    bucket: match[3],
    key: match[4],
  };
};

////////////////////////////////////////////////////////////////////////////////
// HANDLER
////////////////////////////////////////////////////////////////////////////////
export const handler = async (event) => {
  try {
    console.log("Main handler invoked with event:", event);

    // This is an HTTP request to upload a file
    console.log("Routing to uploadHandler");
    const uploadResponse = await uploadHandler(event);

    const audioBody = JSON.parse(uploadResponse.body);
    console.log("Routing to transcribeHandler with audioData:", audioBody);

    console.log("Routing to transcribeHandler");
    const transcribeResponse = await transcribeHandler(audioBody);
    const transcribeBody = JSON.parse(transcribeResponse.body);

    console.log("Routing to translateHandler");
    const translateResponse = await translateHandler(transcribeBody);
    const translateBody = JSON.parse(translateResponse.body);

    const voiceResponse = await voiceHandler(translateBody);
    return voiceResponse;
  } catch (error) {
    console.error("Main handler error:", error);
    return {
      statusCode: 500,
      body: JSON.stringify({ error: "An error occurred in the main handler" }),
    };
  }
};
