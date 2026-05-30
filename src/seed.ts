import bcrypt from "bcryptjs";
import { prisma } from "./db.js";

export async function seedDatabaseIfEmpty(): Promise<void> {
  try {
    const userCount = await prisma.user.count();
    if (userCount > 0) {
      console.log("Cơ sở dữ liệu đã có dữ liệu. Bỏ qua khởi tạo mẫu.");
      return;
    }

    console.log("Cơ sở dữ liệu trống. Bắt đầu khởi tạo dữ liệu mẫu...");

    const hashedPassword = await bcrypt.hash("user123", 10);
    const hashedAdminPassword = await bcrypt.hash("admin123", 10);

    await prisma.user.create({
      data: {
        email: "user@toeic.com",
        password: hashedPassword,
        name: "Học viên Demo",
        role: "USER",
      },
    });

    await prisma.user.create({
      data: {
        email: "admin@toeic.com",
        password: hashedAdminPassword,
        name: "Quản trị viên",
        role: "ADMIN",
      },
    });

    console.log(`Đã tạo tài khoản:
      - Học viên: user@toeic.com / user123
      - Quản trị: admin@toeic.com / admin123`);

    const test = await prisma.test.create({
      data: {
        title: "Đề thi TOEIC Chẩn đoán #1",
        description:
          "Đề thi TOEIC tổng hợp bao gồm tất cả phần Nghe và Đọc (Part 1 đến Part 7) để đánh giá trình độ cơ sở.",
        published: true,
      },
    });

    const devPart1 = await prisma.testPart.create({
      data: {
        testId: test.id,
        partNumber: 1,
        title: "Part 1: Mô tả Hình ảnh",
        instructions:
          "Xem mô tả hình ảnh. Chọn đáp án mô tả chính xác nhất cảnh trong hình.",
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
        title: "Part 2: Hỏi - Đáp",
        instructions:
          "Bạn sẽ nghe một câu hỏi hoặc phát biểu và ba lựa chọn trả lời. Chọn câu trả lời phù hợp nhất.",
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
        title: "Part 3: Hội thoại",
        instructions:
          "Nghe đoạn hội thoại giữa hai hoặc nhiều người. Trả lời các câu hỏi hiểu bài.",
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
        title: "Part 4: Bài nói ngắn",
        instructions: "Nghe bài nói ngắn hoặc thông báo. Chọn đáp án phù hợp.",
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
        title: "Part 5: Hoàn thành Câu",
        instructions:
          "Chọn đáp án phù hợp nhất để hoàn thành câu. (Lưu ý: Trong phần đọc, bạn có thể nhấn vào từ vựng khó để đánh dấu ôn tập!)",
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
      A: "additionally",
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
        title: "Part 6: Điền vào Đoạn văn",
        instructions:
          "Đọc đoạn văn và chọn từ hoặc cụm từ phù hợp nhất để điền vào chỗ trống.",
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
        title: "Part 7: Đọc hiểu",
        instructions:
          "Đọc bài báo hoặc đoạn hội thoại và chọn đáp án đúng dựa trên ngữ cảnh.",
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

    console.log("Khởi tạo dữ liệu mẫu hoàn tất.");
  } catch (error) {
    console.error("Lỗi nghiêm trọng: khởi tạo dữ liệu mẫu thất bại:", error);
  }
}
