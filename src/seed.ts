import bcrypt from "bcryptjs";
import { prisma } from "./db.js";

export async function seedDatabaseIfEmpty(): Promise<void> {
  try {
    const userCount = await prisma.user.count();
    if (userCount > 0) {
      console.log("Database already populated. Skipping automatic seeding.");
      return;
    }

    console.log("Database is empty. Initiating automatic seeding...");

    const hashedPassword = await bcrypt.hash("user123", 10);
    const hashedAdminPassword = await bcrypt.hash("admin123", 10);

    await prisma.user.create({
      data: {
        email: "user@toeic.com",
        password: hashedPassword,
        name: "Mock Learner",
        role: "USER",
      },
    });

    await prisma.user.create({
      data: {
        email: "admin@toeic.com",
        password: hashedAdminPassword,
        name: "System Director",
        role: "ADMIN",
      },
    });

    console.log(`Created accounts:
      - Student: user@toeic.com / user123
      - Admin: admin@toeic.com / admin123`);

    const test = await prisma.test.create({
      data: {
        title: "TOEIC Diagnostic Practice Test #1",
        description:
          "A fast full-spectrum TOEIC review test including all listening and reading sections (Part 1 to Part 7) to check baseline scores.",
        published: true,
      },
    });

    const devPart1 = await prisma.testPart.create({
      data: {
        testId: test.id,
        partNumber: 1,
        title: "Part 1: Photographs",
        instructions:
          "Look at the description of the illustration. Select the option that best describes the scene.",
      },
    });
    const q1 = await prisma.question.create({
      data: {
        testPartId: devPart1.id,
        questionNumber: 1,
        questionText: "Look at the photograph. Which statement best describes the picture?",
        image:
          "https://images.unsplash.com/photo-1497366216548-37526070297c?auto=format&fit=crop&q=80&w=400",
        transcript:
          "Narrator Statement A: A computer monitor is turned off.\nNarrator Statement B: Some people are working at their desks.\nNarrator Statement C: The office building is completely empty.\nNarrator Statement D: Coffee cups are standing in a drawer.",
        correctAnswer: "B",
      },
    });
    for (const [letter, text] of Object.entries({
      A: "Monitor is turned off",
      B: "Some people are working at their desks.",
      C: "The office building is empty",
      D: "Coffee cups in a drawer",
    })) {
      await prisma.option.create({ data: { questionId: q1.id, letter, text } });
    }

    const devPart2 = await prisma.testPart.create({
      data: {
        testId: test.id,
        partNumber: 2,
        title: "Part 2: Question-Response",
        instructions:
          "You will hear a question or statement and three responses. Select the best response.",
      },
    });
    const q2 = await prisma.question.create({
      data: {
        testPartId: devPart2.id,
        questionNumber: 2,
        questionText: "Where is the marketing division file directory saved?",
        transcript:
          "Speaker A: Yes, we did launch the campaign last Monday.\nSpeaker B: It's in the shared drive under the branding directory.\nSpeaker C: No, I didn't see the new supervisor.",
        correctAnswer: "B",
      },
    });
    for (const [letter, text] of Object.entries({
      A: "Yes, campaigns launched.",
      B: "In the shared drive under the branding directory.",
      C: "No, I didn't see the supervisor.",
      D: "(Not used in Part 2)",
    })) {
      await prisma.option.create({ data: { questionId: q2.id, letter, text } });
    }

    const devPart3 = await prisma.testPart.create({
      data: {
        testId: test.id,
        partNumber: 3,
        title: "Part 3: Conversations",
        instructions:
          "Listen to a dialogue between two or more people. Answer the comprehension questions.",
      },
    });
    const q3 = await prisma.question.create({
      data: {
        testPartId: devPart3.id,
        questionNumber: 3,
        questionText: "What are the speakers discussing?",
        transcript:
          "Woman: Peter, have you received the client confirmation for the trade show display booth?\nMan: Yes, they want us to add two more product layout shelves, but that means we might exceed our cargo weight bounds.\nWoman: Oh, in that case, we should check with the shipping department immediately.",
        correctAnswer: "C",
      },
    });
    for (const [letter, text] of Object.entries({
      A: "Adjusting conference tickets",
      B: "Opening a new design shop",
      C: "Cargo dimensions for a trade show shipment",
      D: "Hiring a new cargo supervisor",
    })) {
      await prisma.option.create({ data: { questionId: q3.id, letter, text } });
    }

    const devPart4 = await prisma.testPart.create({
      data: {
        testId: test.id,
        partNumber: 4,
        title: "Part 4: Short Talks",
        instructions: "Listen to a short monologue or talk. Select the appropriate options.",
      },
    });
    const q4 = await prisma.question.create({
      data: {
        testPartId: devPart4.id,
        questionNumber: 4,
        questionText: "Who is the speaker targeting with this announcement?",
        transcript:
          "Attention all warehouse operators. Due to the high-voltage electrical check scheduled for this afternoon, standard container forklift bays three through five will be shut down starting from two PM. Please coordinate with regional delivery supervisors to load shipments from alternative platforms.",
        correctAnswer: "A",
      },
    });
    for (const [letter, text] of Object.entries({
      A: "Warehouse equipment operators",
      B: "Electrical engineering inspectors",
      C: "Retail customer buyers",
      D: "Office administrative assistants",
    })) {
      await prisma.option.create({ data: { questionId: q4.id, letter, text } });
    }

    const devPart5 = await prisma.testPart.create({
      data: {
        testId: test.id,
        partNumber: 5,
        title: "Part 5: Incomplete Sentences",
        instructions:
          "Select the option that best completes the sentence. (Note: Inside reading views, feel free to highlight any difficult vocabulary words to automatically capture them!).",
      },
    });
    const q5 = await prisma.question.create({
      data: {
        testPartId: devPart5.id,
        questionNumber: 5,
        questionText:
          "The executive committee will assemble tomorrow to discuss the ________ budget requirements for the next retail campaign.",
        correctAnswer: "C",
      },
    });
    for (const [letter, text] of Object.entries({
      A: "additional",
      B: "addition",
      C: "additional",
      D: "additionary",
    })) {
      await prisma.option.create({ data: { questionId: q5.id, letter, text } });
    }

    const devPart6 = await prisma.testPart.create({
      data: {
        testId: test.id,
        partNumber: 6,
        title: "Part 6: Text Completion",
        instructions:
          "Read the passage and select the best words or phrases to complete the blanks.",
      },
    });
    const q6 = await prisma.question.create({
      data: {
        testPartId: devPart6.id,
        questionNumber: 6,
        passage:
          "To: All Personnel\nFrom: Facilities Management\nSubject: Office Air Filtration System Upgrade\n\nNext Sunday, we will undergo a thorough restoration of our air filtration system. This enhancement is designed to reduce ambient particulate matters and protect the wellness of our staff.",
        questionText:
          "This enhancement is designed to ________ ambient particulate matters and protect wellness.",
        correctAnswer: "A",
      },
    });
    for (const [letter, text] of Object.entries({
      A: "diminish",
      B: "abandoning",
      C: "glorify",
      D: "exasperate",
    })) {
      await prisma.option.create({ data: { questionId: q6.id, letter, text } });
    }

    const devPart7 = await prisma.testPart.create({
      data: {
        testId: test.id,
        partNumber: 7,
        title: "Part 7: Reading Comprehension",
        instructions:
          "Read the article or dialog and select the correct answers based on the context.",
      },
    });
    const q7 = await prisma.question.create({
      data: {
        testPartId: devPart7.id,
        questionNumber: 7,
        passage:
          "Apex Logistics Inc. has announced the formal acquisition of Cascade Courier Services, a private regional delivery network operating out of Seattle. This strategic move allows Apex Logistics to solidify its dominance over critical northwestern supply routes, ensuring faster package deliveries across five key states.",
        questionText:
          "What is the primary motivation stated for Cascade Courier Services acquisition?",
        correctAnswer: "C",
      },
    });
    for (const [letter, text] of Object.entries({
      A: "To expand regional Seattle courier staff",
      B: "To downsize supply routes",
      C: "To solidify territorial dominance over key supply networks",
      D: "To enter consumer electronics lines",
    })) {
      await prisma.option.create({ data: { questionId: q7.id, letter, text } });
    }

    console.log("Automatic database seed completed successfully.");
  } catch (error) {
    console.error("Critical: automatic database seeding failed:", error);
  }
}
