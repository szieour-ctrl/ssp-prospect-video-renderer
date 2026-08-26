// ─────────────────────────────────────────────────────────────
// PROSPECT EMAIL THUMBNAIL
// ─────────────────────────────────────────────────────────────

app.post(
  "/render-prospect-thumbnail",
  async (req, res) => {
    const {
      before_image_url,
      after_image_url,

      before_label = "ORIGINAL LISTING PHOTO",
      after_label = "SMART STAGE PRO PREVIEW",

      prospect_id = "prospect",
      agent_name = "",
      property_address = "",
      mls_number = ""
    } = req.body || {};

    if (
      !before_image_url ||
      !after_image_url
    ) {
      return res.status(400).json({
        success: false,
        error:
          "Missing before_image_url or after_image_url"
      });
    }

    const safeBeforeLabel =
      escapeDrawtext(before_label);

    const safeAfterLabel =
      escapeDrawtext(after_label);

    const safeProspectId =
      makeSafePublicId(prospect_id) ||
      "prospect";

    const workDir =
      fs.mkdtempSync(
        path.join(
          os.tmpdir(),
          "ssp-thumb-"
        )
      );

    const beforePath =
      path.join(
        workDir,
        "before.jpg"
      );

    const afterPath =
      path.join(
        workDir,
        "after.jpg"
      );

    const outputPath =
      path.join(
        workDir,
        "thumbnail.jpg"
      );

    try {
      console.log(
        `[PROSPECT THUMBNAIL] Starting render for ${safeProspectId}`
      );

      await downloadFile(
        before_image_url,
        beforePath
      );

      await downloadFile(
        after_image_url,
        afterPath
      );

      // Each source image fills a 960x1080 half-frame.
      // Excess image area is center-cropped instead of padded.
      const filter = [
        `[0:v]
         scale=960:1080:force_original_aspect_ratio=increase,
         crop=960:1080:(iw-960)/2:(ih-1080)/2,
         setsar=1
         [before]`,

        `[1:v]
         scale=960:1080:force_original_aspect_ratio=increase,
         crop=960:1080:(iw-960)/2:(ih-1080)/2,
         setsar=1
         [after]`,

        `[before][after]
         hstack=inputs=2,

         drawbox=
         x=958:
         y=0:
         w=4:
         h=1080:
         color=white@0.95:
         t=fill,

         drawbox=
         x=(w/2)-80:
         y=(h/2)-80:
         w=160:
         h=160:
         color=black@0.45:
         t=fill,

         drawtext=
         text='▶':
         fontcolor=white:
         fontsize=96:
         x=(w-tw)/2+6:
         y=(h-th)/2-4,

         drawtext=
         text='${safeBeforeLabel}':
         fontcolor=white:
         fontsize=34:
         box=1:
         boxcolor=black@0.55:
         boxborderw=14:
         x=40:
         y=h-th-40,

         drawtext=
         text='${safeAfterLabel}':
         fontcolor=white:
         fontsize=34:
         box=1:
         boxcolor=black@0.55:
         boxborderw=14:
         x=w-tw-40:
         y=h-th-40

         [out]`
      ]
        .join(";")
        .replace(/\s*\n\s*/g, "");

      await execFileAsync(
        "ffmpeg",
        [
          "-y",

          "-i",
          beforePath,

          "-i",
          afterPath,

          "-filter_complex",
          filter,

          "-map",
          "[out]",

          "-frames:v",
          "1",

          "-q:v",
          "2",

          outputPath
        ],
        {
          maxBuffer:
            20 * 1024 * 1024
        }
      );

      // ───────────────────────────────────────────────────────
      // UPLOAD THUMBNAIL TO S3
      // ───────────────────────────────────────────────────────

      const thumbnailKey =
        `ssp-prospects/${safeProspectId}/thumbnail.jpg`;

      const upload =
        await uploadFileToS3({
          filePath: outputPath,
          key: thumbnailKey,
          contentType: "image/jpeg"
        });

      console.log(
        `[PROSPECT THUMBNAIL] Uploaded to S3: ${upload.key}`
      );

      return res.json({
        success: true,

        image_url: upload.url,

        public_id: upload.key,

        prospect: {
          prospect_id,
          agent_name,
          property_address,
          mls_number
        },

        thumbnail: {
          width: 1920,
          height: 1080,
          before_label,
          after_label
        }
      });
    } catch (error) {
      console.error(
        "[PROSPECT THUMBNAIL] Render failed:",
        error.stderr ||
          error.message ||
          error
      );

      return res.status(500).json({
        success: false,
        error:
          error.message ||
          "Prospect thumbnail rendering failed"
      });
    } finally {
      try {
        fs.rmSync(
          workDir,
          {
            recursive: true,
            force: true
          }
        );
      } catch (cleanupError) {
        console.error(
          "[PROSPECT THUMBNAIL] Cleanup failed:",
          cleanupError.message
        );
      }
    }
  }
);
